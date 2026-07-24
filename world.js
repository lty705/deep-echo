/* ============================================================
 * 世界生成 (World)
 * 种子化房间+走廊;埋入隐藏墙(2)/暗门(3)/出口(4)。
 * 提供:碰撞查询、攻击破墙/破门、敌人/遗物/碎片埋点。
 * 瓦片类型: 0 墙 | 1 地板 | 2 隐藏墙 | 3 暗门 | 4 出口(地板下)
 * ============================================================ */

const World = {
  T_WALL: 0, T_FLOOR: 1, T_HIDDEN: 2, T_DOOR: 3, T_EXIT: 4,
  ts: CONFIG.floor.tileSize,
  W: 0, H: 0,
  grid: null,
  rooms: [],
  spawn: null,   // {x,y} 像素
  exit: null,
  floorNum: 1,
  enemySpawns: [],   // [{x,y,type,hpMul,dmgMul}]
  eliteSpawns: [],   // [{x,y,hpMul,dmgMul}] 精英
  bossSpawn: null,   // {x,y,hpMul,dmgMul} Boss
  relicSpawns: [],   // [{x,y}]
  shardSpawns: [],   // [{x,y}]
  shrineSpawns: [],  // [{x,y}] 祭坛(抉择)
  riskyQueue: [],    // 破门后追加的敌人 [{x,y,hpMul,dmgMul}]

  solid(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.W || ty >= this.H) return true;
    const t = this.grid[ty][tx];
    return t === this.T_WALL || t === this.T_HIDDEN || t === this.T_DOOR;
  },
  solidAtPx(px, py) {
    return this.solid(Math.floor(px / this.ts), Math.floor(py / this.ts));
  },
  tileAt(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.W || ty >= this.H) return this.T_WALL;
    return this.grid[ty][tx];
  },

  generate(seed, floorNum) {
    this.floorNum = floorNum;
    this.W = CONFIG.floor.mapW;
    this.H = CONFIG.floor.mapH;
    this.grid = [];
    for (let y = 0; y < this.H; y++) this.grid.push(new Array(this.W).fill(this.T_WALL));
    const rng = makeRNG(seed ^ (floorNum * 2654435761));

    // 1) 房间
    this.rooms = [];
    const R = CONFIG.floor.rooms;
    let tries = 0;
    while (this.rooms.length < R && tries < R * 30) {
      tries++;
      const w = CONFIG.floor.roomMin + Math.floor(rng() * (CONFIG.floor.roomMax - CONFIG.floor.roomMin + 1));
      const h = CONFIG.floor.roomMin + Math.floor(rng() * (CONFIG.floor.roomMax - CONFIG.floor.roomMin + 1));
      const x = 1 + Math.floor(rng() * (this.W - w - 2));
      const y = 1 + Math.floor(rng() * (this.H - h - 2));
      const room = { x, y, w, h, cx: Math.floor(x + w / 2), cy: Math.floor(y + h / 2) };
      let overlap = false;
      for (const o of this.rooms) {
        if (x - 1 < o.x + o.w && x + w + 1 > o.x && y - 1 < o.y + o.h && y + h + 1 > o.y) { overlap = true; break; }
      }
      if (overlap) continue;
      this.rooms.push(room);
      for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++) this.grid[yy][xx] = this.T_FLOOR;
    }

    // 2) 走廊连接房间中心
    for (let i = 1; i < this.rooms.length; i++) {
      const a = this.rooms[i - 1], b = this.rooms[i];
      this._carveH(a.cx, b.cx, a.cy, rng);
      this._carveV(a.cy, b.cy, b.cx, rng);
    }

    // 3) 出生点 / 出口
    const s = this.rooms[0], e = this.rooms[this.rooms.length - 1];
    this.spawn = { x: (s.cx + 0.5) * this.ts, y: (s.cy + 0.5) * this.ts };
    this.exit = { x: (e.cx + 0.5) * this.ts, y: (e.cy + 0.5) * this.ts };
    this.grid[e.cy][e.cx] = this.T_EXIT;

    // 4) 隐藏墙:选贴近地板的墙,转成可破的隐藏墙
    const floorTiles = [];
    for (let y = 1; y < this.H - 1; y++)
      for (let x = 1; x < this.W - 1; x++)
        if (this.grid[y][x] === this.T_FLOOR) floorTiles.push({ x, y });
    const hiddenCount = CONFIG.floor.hiddenDensity + Math.floor(rng() * 2);
    for (let i = 0; i < hiddenCount; i++) {
      const f = floorTiles[Math.floor(rng() * floorTiles.length)];
      const cand = this._adjacentWall(f.x, f.y, rng);
      if (cand) this.grid[cand.y][cand.x] = this.T_HIDDEN;
    }

    // 5) 暗门(好奇 vs 风险):在死路/边缘处放一扇
    if (rng() < CONFIG.floor.secretDoorChance) {
      const dead = floorTiles.filter(f => this._floorNeighborCount(f.x, f.y) === 1);
      if (dead.length) {
        const f = dead[Math.floor(rng() * dead.length)];
        const cand = this._adjacentWall(f.x, f.y, rng);
        if (cand) this.grid[cand.y][cand.x] = this.T_DOOR;
      }
    }

    // 6) 埋点:敌人 / 精英 / Boss / 遗物 / 碎片 / 祭坛
    this.enemySpawns = []; this.eliteSpawns = []; this.bossSpawn = null;
    this.relicSpawns = []; this.shardSpawns = []; this.shrineSpawns = []; this.riskyQueue = [];
    const usable = floorTiles.filter(f => this.grid[f.y][f.x] === this.T_FLOOR &&
      !(f.x === s.cx && f.y === s.cy) && !(f.x === e.cx && f.y === e.cy));

    const isBoss = CONFIG.enemy.bossFloors.includes(floorNum);
    const hpMul = 1 + 0.15 * (floorNum - 1);
    const dmgMul = 1 + 0.10 * (floorNum - 1);
    const enemyCount = Math.max(3, Math.round(CONFIG.floor.enemyBase + floorNum * CONFIG.floor.enemyPerFloor) - (isBoss ? 4 : 0));
    const relicCount = 1 + (rng() < 0.5 ? 1 : 0);
    const shardCount = 3 + Math.floor(rng() * 3);
    const pick = (arr) => arr.splice(Math.floor(rng() * arr.length), 1)[0];
    const roomCenter = (idx) => {
      const r = this.rooms[idx];
      return r ? { x: (r.cx + 0.5) * this.ts, y: (r.cy + 0.5) * this.ts } : null;
    };

    for (let i = 0; i < enemyCount && usable.length; i++) {
      const f = pick(usable);
      this.enemySpawns.push({ x: (f.x + 0.5) * this.ts, y: (f.y + 0.5) * this.ts, type: this._weightedType(rng), hpMul, dmgMul });
    }
    // 精英(非 Boss 层)
    if (!isBoss && rng() < CONFIG.enemy.eliteChance) {
      const c = roomCenter(1 + Math.floor(rng() * (this.rooms.length - 2)));
      if (c) this.eliteSpawns.push({ x: c.x, y: c.y, hpMul, dmgMul });
    }
    // Boss(5/10 层)
    if (isBoss) {
      const c = roomCenter(Math.floor(this.rooms.length / 2)) || roomCenter(this.rooms.length - 1);
      if (c) this.bossSpawn = { x: c.x, y: c.y, hpMul, dmgMul };
    }
    for (let i = 0; i < relicCount && usable.length; i++) {
      const f = pick(usable);
      this.relicSpawns.push({ x: (f.x + 0.5) * this.ts, y: (f.y + 0.5) * this.ts });
    }
    for (let i = 0; i < shardCount && usable.length; i++) {
      const f = pick(usable);
      this.shardSpawns.push({ x: (f.x + 0.5) * this.ts, y: (f.y + 0.5) * this.ts });
    }
    // 祭坛(风险 vs 收益抉择)——每层必出(核心玩法);单房间时退回起始房间中心兜底
    {
      const idx = this.rooms.length > 1 ? 1 + Math.floor(rng() * (this.rooms.length - 1)) : 0;
      const c = roomCenter(idx) || roomCenter(0);
      if (c) this.shrineSpawns.push({ x: c.x, y: c.y });
    }
  },

  _carveH(x1, x2, y, rng) {
    const a = Math.min(x1, x2), b = Math.max(x1, x2);
    for (let x = a; x <= b; x++)
      for (let dy = 0; dy < 2; dy++) {
        const yy = y + dy;
        if (this.grid[yy] && this.grid[yy][x] === this.T_WALL) this.grid[yy][x] = this.T_FLOOR;
      }
  },
  _carveV(y1, y2, x, rng) {
    const a = Math.min(y1, y2), b = Math.max(y1, y2);
    for (let y = a; y <= b; y++)
      for (let dx = 0; dx < 2; dx++) {
        const xx = x + dx;
        if (this.grid[y] && this.grid[y][xx] === this.T_WALL) this.grid[y][xx] = this.T_FLOOR;
      }
  },
  _adjacentWall(x, y, rng) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const list = [];
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx > 0 && ny > 0 && nx < this.W - 1 && ny < this.H - 1 && this.grid[ny][nx] === this.T_WALL)
        list.push({ x: nx, y: ny });
    }
    if (!list.length) return null;
    return list[Math.floor(rng() * list.length)];
  },
  _floorNeighborCount(x, y) {
    let c = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < this.W && ny < this.H && this.grid[ny][nx] === this.T_FLOOR) c++;
    }
    return c;
  },

  /* 按权重随机敌人类型 */
  _weightedType(rng) {
    const t = CONFIG.enemy.types;
    let r = rng(), acc = 0;
    for (const k in t) { acc += t[k]; if (r <= acc) return k; }
    return 'walker';
  },

  /* 攻击破墙/破门:返回奖励信息 */
  breakAt(tx, ty) {
    const t = this.tileAt(tx, ty);
    const px = (tx + 0.5) * this.ts, py = (ty + 0.5) * this.ts;
    if (t === this.T_HIDDEN) {
      this.grid[ty][tx] = this.T_FLOOR;
      const isRelic = Math.random() < 0.5;
      return { kind: isRelic ? 'relic' : 'shards', x: px, y: py };
    }
    if (t === this.T_DOOR) {
      this.grid[ty][tx] = this.T_FLOOR;
      // 险路:追加更强敌人
      for (let i = 0; i < 2; i++) {
        const ang = Math.random() * Math.PI * 2;
        this.riskyQueue.push({
          x: px + Math.cos(ang) * this.ts, y: py + Math.sin(ang) * this.ts,
          shooter: Math.random() < 0.5,
          hpMul: (1 + 0.15 * (this.floorNum - 1)) * CONFIG.floor.riskyMult,
          dmgMul: (1 + 0.10 * (this.floorNum - 1)) * CONFIG.floor.riskyMult,
        });
      }
      return { kind: 'relic', x: px, y: py, risky: true };
    }
    return null;
  },
};
