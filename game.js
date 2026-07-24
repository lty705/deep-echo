/* ============================================================
 * 主整合 (Game)
 * 状态机 + 主循环 + 相机 + 渲染,串联 输入/世界/实体/遗物/元进度。
 * 状态: menu | playing | dead | codex | unlock
 * ============================================================ */

const Game = {
  canvas: null, ctx: null, dpr: 1,
  state: 'menu',
  cam: { x: 0, y: 0 },
  player: null,
  enemies: [], bullets: [], particles: [], dmgTexts: [], effects: [],
  relicPickups: [], shardPickups: [],
  floorNum: 1,
  runEcho: 0, runDiscoveries: 0,
  hitStopT: 0, shakeMag: 0,
  seed: 0,
  lastTs: 0,
  hintT: 0,
  time: 0,
  _lastHp: undefined,
  _relicCount: 0,
  motes: null,

  init() {
    try {
      this.canvas = document.getElementById('game');
      this.ctx = this.canvas.getContext('2d');
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.resize();
      window.addEventListener('resize', () => this.resize());
      Input.init(this.canvas);
      Meta.load();
      this.bindUI();
      this.applyTheme(LS.get('deep_echo_theme') || 'system');
    } catch (e) {
      // 任何初始化步骤(如沙盒环境禁用 API)失败,都不应阻断主循环启动
      console.warn('[DeepEcho] init 部分失败:', e);
    }
    this.lastTs = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  },

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = w * this.dpr; this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  },

  // 同时绑定 click 与 touchstart,移动端点击最稳妥(避免某些浏览器 onclick 不触发被吞)
  bindTap(el, fn) {
    if (!el) return;
    el.addEventListener('click', fn);
    el.addEventListener('touchstart', (e) => { e.preventDefault(); fn(e); }, { passive: false });
  },

  bindUI() {
    const $ = (id) => document.getElementById(id);
    const bind = (id, fn) => this.bindTap($(id), fn);
    bind('btnStart', () => this.openSelect());
    bind('btnDaily', () => this.openSelect());
    bind('btnSelectBack', () => this.toMenu());
    bind('btnConfirmSelect', () => this.startRun(todaySeed(), this._selClass || CLASSES[0].id));
    bind('btnCodex', () => this.openCodex());
    bind('btnUnlock', () => this.openUnlock());
    bind('btnRetry', () => this.startRun(todaySeed()));
    bind('btnMenu', () => this.toMenu());
    bind('btnCodexBack', () => this.toMenu());
    bind('btnUnlockBack', () => this.toMenu());
    bind('btnBuyHp', () => {
      if (Meta.unlockHp()) { this.renderUnlock(); this.flashToast('已强化:最大生命 +20'); }
      else this.flashToast('回响不足');
    });
    bind('btnAbility', () => this.useAbility());
    bind('btnShrineSacrifice', () => this.resolveShrine('sacrifice'));
    bind('btnShrinePray', () => this.resolveShrine('pray'));
    bind('btnShrineLeave', () => { this.state = 'playing'; this.showOverlay(null); });
    bind('themeToggle', () => {
      const cur = LS.get('deep_echo_theme') || 'system';
      const next = cur === 'system' ? 'light' : (cur === 'light' ? 'dark' : 'system');
      this.applyTheme(next);
    });
  },

  applyTheme(mode) {
    LS.set('deep_echo_theme', mode);
    const m = mode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : mode;
    document.documentElement.setAttribute('data-theme', m);
    document.getElementById('themeToggle').textContent = m === 'light' ? '☀️' : '🌙';
  },

  // ---------- 运行控制 ----------
  startRun(seedStr, classId) {
    this.seed = hashSeed(seedStr);
    this.floorNum = 1;
    this.runEcho = 0; this.runDiscoveries = 0;
    this._relicCount = 0; this._lastHp = undefined;
    this.enemies = []; this.bullets = []; this.particles = []; this.dmgTexts = []; this.effects = [];
    this.relicPickups = []; this.shardPickups = []; this.shrinePickups = [];
    this.boss = null;
    const cls = getClass(classId);
    const maxHp = CONFIG.player.maxHp + Meta.bonusMaxHp() + (cls.mods.maxHpAdd || 0);
    this.player = new Player(0, 0, maxHp, cls.id);
    LS.set('deep_echo_class', cls.id);
    this.generateFloor();
    this.state = 'playing';
    this.hintT = 4.5;
    this.showOverlay(null);
    document.getElementById('hud').classList.add('show');
    this.flashToast('✦ ' + cls.name + (cls.line ? ' — ' + cls.line : ''), 'discovery');
  },

  generateFloor() {
    World.generate(this.seed, this.floorNum);
    this.player.x = World.spawn.x; this.player.y = World.spawn.y;
    this.player.dashTimer = 0; this.player.iframes = 0.5;
    this.spawnWorldEntities();
    this.cam.x = this.player.x - window.innerWidth / 2;
    this.cam.y = this.player.y - window.innerHeight / 2;
  },

  spawnWorldEntities() {
    for (const s of World.enemySpawns)
      this.enemies.push(new Enemy(s.x, s.y, { type: s.type, hpMul: s.hpMul, dmgMul: s.dmgMul }));
    for (const s of World.riskyQueue)
      this.enemies.push(new Enemy(s.x, s.y, { type: s.type || 'walker', shooter: s.shooter, hpMul: s.hpMul, dmgMul: s.dmgMul }));
    World.riskyQueue = [];
    for (const s of World.eliteSpawns)
      this.enemies.push(new Enemy(s.x, s.y, { type: 'walker', elite: true, hpMul: s.hpMul, dmgMul: s.dmgMul }));
    if (World.bossSpawn) {
      const b = new Enemy(World.bossSpawn.x, World.bossSpawn.y, { type: 'boss', boss: true, hpMul: World.bossSpawn.hpMul, dmgMul: World.bossSpawn.dmgMul });
      this.enemies.push(b); this.boss = b;
    }
    for (const s of World.relicSpawns) {
      const def = RELICS[Math.floor(Math.random() * RELICS.length)];
      this.relicPickups.push({ x: s.x, y: s.y, def });
    }
    for (const s of World.shardSpawns) this.shardPickups.push({ x: s.x, y: s.y, amount: CONFIG.economy.shardPerKill });
    for (const s of World.shrineSpawns) this.shrinePickups.push({ x: s.x, y: s.y });
  },

  nextFloor() {
    if (this.floorNum >= CONFIG.floor.targetFloors) { this.victory(); return; }
    this.floorNum++;
    this.bullets = []; this.enemies = []; this.relicPickups = []; this.shardPickups = [];
    this.particles = []; this.dmgTexts = []; this.shrinePickups = []; this.effects = [];
    this.boss = null;
    this.generateFloor();
    this.flashToast('下潜至 第 ' + this.floorNum + ' 层');
  },

  // ---------- 主循环 ----------
  loop(ts) {
    let dt = (ts - this.lastTs) / 1000;
    this.lastTs = ts;
    this.time = ts / 1000;
    if (dt > 0.05) dt = 0.05; // 防卡顿大跳
    if (this.state === 'playing') this.update(dt);
    this.render();
    requestAnimationFrame((t) => this.loop(t));
  },

  update(dt) {
    Input.update();
    if (this.hitStopT > 0) { this.hitStopT -= dt; this.updateShake(dt); return; }

    this.player.update(dt);

    for (const e of this.enemies) e.update(dt, this.player);
    for (const b of this.bullets) b.update(dt);
    for (const p of this.particles) p.update(dt);
    for (const d of this.dmgTexts) d.update(dt);
    for (const f of this.effects) f.update(dt);

    // 荆棘:触碰敌人造成伤害(并推断)
    if (this.player.touchDmg > 0 && this.player.touchCd <= 0) {
      for (const e of this.enemies) {
        if (Math.hypot(e.x - this.player.x, e.y - this.player.y) < e.radius + this.player.radius) {
          e.takeDamage(this.player.touchDmg);
          this.player.touchCd = 0.4;
          Relics.onTouch(this.player);
          break;
        }
      }
    }

    // 拾取遗物/碎片
    this.collectPickups();

    // 祭坛抉择(风险 vs 收益)——触发范围加大,手机更易交互
    const p = this.player;
    const trigR = p.radius + 40;
    for (let i = this.shrinePickups.length - 1; i >= 0; i--) {
      const s = this.shrinePickups[i];
      if (Math.hypot(s.x - p.x, s.y - p.y) < trigR) {
        this.shrinePickups.splice(i, 1);
        this.enterShrine();
        break;
      }
    }

    // 出口
    if (Math.hypot(this.player.x - World.exit.x, this.player.y - World.exit.y) < World.ts * 0.6) {
      this.nextFloor();
    }

    // 清理
    this.enemies = this.enemies.filter(e => !e.dead);
    this.bullets = this.bullets.filter(b => !b.dead);
    this.particles = this.particles.filter(p => !p.dead);
    this.dmgTexts = this.dmgTexts.filter(d => !d.dead);
    this.effects = this.effects.filter(f => !f.dead);

    this.updateShake(dt);
    this.updateCamera(dt);
    if (this.hintT > 0) this.hintT -= dt;
    this.updateHUD();
  },

  updateShake(dt) { this.shakeMag = Math.max(0, this.shakeMag - dt * 30); },
  updateCamera(dt) {
    const tx = this.player.x - window.innerWidth / 2;
    const ty = this.player.y - window.innerHeight / 2;
    this.cam.x += (tx - this.cam.x) * CONFIG.camera.lerp;
    this.cam.y += (ty - this.cam.y) * CONFIG.camera.lerp;
  },

  collectPickups() {
    const p = this.player;
    for (let i = this.relicPickups.length - 1; i >= 0; i--) {
      const r = this.relicPickups[i];
      if (Math.hypot(r.x - p.x, r.y - p.y) < p.radius + 16) {
        Relics.equip(p, r.def);
        this.relicPickups.splice(i, 1);
        this.flashToast('拾得未知遗物 ✦');
      }
    }
    for (let i = this.shardPickups.length - 1; i >= 0; i--) {
      const s = this.shardPickups[i];
      if (Math.hypot(s.x - p.x, s.y - p.y) < p.radius + 14) {
        p.shards = (p.shards || 0) + s.amount;
        p.heal(3);
        this.shardPickups.splice(i, 1);
        this.addParticle(s.x, s.y, '#fbbf24');
      }
    }
  },

  // ---------- 事件 ----------
  spawnPlayerBullet(x, y, dx, dy, dmg) {
    const d = Math.hypot(dx, dy) || 1;
    const sp = 7;
    const damage = dmg || CONFIG.player.attackDamage;
    this.bullets.push(new Bullet(x + dx / d * 18, y + dy / d * 18, dx / d * sp, dy / d * sp, damage, true));
  },
  spawnEnemyBullet(x, y, dx, dy, dmg) {
    this.bullets.push(new Bullet(x, y, dx * CONFIG.enemy.bulletSpeed, dy * CONFIG.enemy.bulletSpeed, dmg, false));
  },
  addDamageText(x, y, text, color) { this.dmgTexts.push(new DamageText(x, y, text, color)); },
  addParticle(x, y, color) { for (let i = 0; i < 6; i++) this.particles.push(new Particle(x, y, color)); },
  addSpark(x, y, color, vx, vy) { this.particles.push(new Spark(x, y, vx, vy, color)); },
  addSlash(x, y, dx, dy) { this.effects.push(new Slash(x, y, dx, dy)); },
  addImpact(x, y, color, dx, dy) { this.effects.push(new HitRing(x, y, color, dx, dy)); },
  hitStop(t) { this.hitStopT = Math.max(this.hitStopT, t); },
  shake(m) { this.shakeMag = Math.max(this.shakeMag, m); },

  enemyAt(x, y) {
    for (const e of this.enemies) if (Math.hypot(e.x - x, e.y - y) < e.radius + 6) return e;
    return null;
  },

  /* 分裂体:死亡时生成子代(限定代数) */
  spawnSplitter(x, y, gen) {
    const hpMul = 1 + 0.15 * (this.floorNum - 1);
    const dmgMul = 1 + 0.10 * (this.floorNum - 1);
    this.enemies.push(new Enemy(x, y, { type: 'splitter', gen, hpMul, dmgMul }));
  },

  /* 完美闪避反震:震退并伤害周围敌人 + 慢动作 */
  triggerParry(x, y) {
    const R = CONFIG.combat.parryRadius * World.ts;
    for (const e of this.enemies) {
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < R + e.radius) {
        const a = Math.atan2(e.y - y, e.x - x);
        e.takeDamage(CONFIG.combat.parryDamage, x, y);
        if (!e.dead) { e.x += Math.cos(a) * CONFIG.combat.parryKnock; e.y += Math.sin(a) * CONFIG.combat.parryKnock; }
      }
    }
    this.hitStop(CONFIG.combat.parrySlowmo);
    this.shake(10);
    for (let i = 0; i < 14; i++) this.particles.push(new Particle(x, y, '#a5f3fc'));
    this.flashToast('✦ 完美闪避!');
  },

  /* 主动技能:使用第一个就绪的能力 */
  useAbility(id) {
    const p = this.player;
    if (!p || !p.abilities.length) return;
    const ab = id ? p.abilities.find(a => a.id === id) : p.abilities[0];
    if (!ab || (p.abilityCd[ab.id] || 0) > 0) return;
    if (ab.kind === 'nova') {
      const R = ab.radius * World.ts;
      for (const e of this.enemies) {
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d < R + e.radius) {
          const a = Math.atan2(e.y - p.y, e.x - p.x);
          e.takeDamage(ab.dmg, p.x, p.y);
          if (!e.dead) { e.x += Math.cos(a) * ab.knock; e.y += Math.sin(a) * ab.knock; }
        }
      }
      this.hitStop(0.1); this.shake(9);
      for (let i = 0; i < 18; i++) this.particles.push(new Particle(p.x, p.y, '#22d3ee'));
      this.flashToast('✦ 新星爆发!');
    }
    p.abilityCd[ab.id] = ab.cooldown;
    Relics.tryDiscover(p, ab.id);  // 首次使用才揭示效果(无名遗物核心)
  },

  onEnemyDeath(e) {
    for (let i = 0; i < 12; i++) this.particles.push(new Particle(e.x, e.y, '#fb7185'));
    this.addImpact(e.x, e.y, '#fb7185', 0, -1);
    if (e.boss) {
      this.boss = null;
      document.getElementById('bossBar').classList.remove('show');
      for (let i = 0; i < 2; i++) {
        const def = RELICS[Math.floor(Math.random() * RELICS.length)];
        this.relicPickups.push({ x: e.x + (i ? 18 : -18), y: e.y, def });
      }
      Meta.addEcho(CONFIG.economy.echoPerBoss);
      this.runEcho += CONFIG.economy.echoPerBoss;
      this.flashToast('✦ 击败首领! 双遗物 + 回响', 'discovery');
    } else if (e.elite) {
      const def = RELICS[Math.floor(Math.random() * RELICS.length)];
      this.relicPickups.push({ x: e.x, y: e.y, def });
      this.flashToast('精英陨落 — 遗物显现');
    }
  },

  /* 攻击破墙/破门:掉落奖励,暗门追加险路敌人 */
  breakWallAt(tx, ty) {
    const res = World.breakAt(tx, ty);
    if (!res) return;
    if (res.kind === 'relic') {
      const def = RELICS[Math.floor(Math.random() * RELICS.length)];
      this.relicPickups.push({ x: res.x, y: res.y, def });
      this.flashToast(res.risky ? '暗门后藏着秘密!' : '墙壁后藏着遗物!');
    } else if (res.kind === 'shards') {
      this.shardPickups.push({ x: res.x, y: res.y, amount: CONFIG.economy.shardPerKill * 2 });
    }
    for (const s of World.riskyQueue) {
      this.enemies.push(new Enemy(s.x, s.y, { shooter: s.shooter, hpMul: s.hpMul, dmgMul: s.dmgMul }));
    }
    World.riskyQueue = [];
  },

  onDiscovery(relic) {
    const info = RELIC_INFO[relic.id];
    Meta.addEcho(CONFIG.economy.echoPerDiscovery);
    this.runDiscoveries++;
    this.runEcho += CONFIG.economy.echoPerDiscovery;
    this.flashToast('✦ 你发现:' + info.name + ' — ' + info.desc, 'discovery');
  },

  enterShrine() {
    this.state = 'shrine';
    this.showOverlay('shrine');
  },
  resolveShrine(choice) {
    try {
      const p = this.player;
      if (choice === 'sacrifice') {
        p.hp = Math.max(1, p.hp - 25);
        const def = RELICS[Math.floor(Math.random() * RELICS.length)];
        this.relicPickups.push({ x: p.x, y: p.y - 22, def });
        this.flashToast('祭坛饮下你的鲜血 — 遗物显现');
      } else if (choice === 'pray') {
        p.hp = Math.max(1, p.hp - 10);
        const gain = 30 + Math.floor(Math.random() * 20);
        Meta.addEcho(gain); this.runEcho += gain;
        this.flashToast('祈祷回响 +' + gain);
      }
    } catch (e) {
      console.warn('[DeepEcho] resolveShrine 异常:', e);
    } finally {
      // 无论如何都恢复游戏,避免弹层卡死
      this.state = 'playing';
      this.showOverlay(null);
    }
  },

  onPlayerDeath() {
    document.getElementById('deathTitle').textContent = '陨落';
    Meta.recordDepth(this.floorNum);
    Meta.addEcho(this.floorNum * CONFIG.economy.echoPerDepth);
    this.runEcho += this.floorNum * CONFIG.economy.echoPerDepth;
    this.state = 'dead';
    document.getElementById('hud').classList.remove('show');
    document.getElementById('deathStats').innerHTML =
      `<div class="stat-row"><span class="k">抵达深度</span><span class="v">第 ${this.floorNum} 层</span></div>` +
      `<div class="stat-row"><span class="k">本局发现</span><span class="v">${this.runDiscoveries} 件</span></div>` +
      `<div class="stat-row"><span class="k">获得回响</span><span class="v echo">+${this.runEcho}</span></div>` +
      `<div class="stat-row"><span class="k">累计回响</span><span class="v echo">${Meta.data.echoes}</span></div>`;
    this.showOverlay('death');
  },

  victory() {
    Meta.recordDepth(CONFIG.floor.targetFloors);
    Meta.addEcho(CONFIG.floor.targetFloors * CONFIG.economy.echoPerDepth);
    this.runEcho += CONFIG.floor.targetFloors * CONFIG.economy.echoPerDepth;
    this.state = 'dead';
    document.getElementById('hud').classList.remove('show');
    document.getElementById('deathTitle').textContent = '🏆 通关!';
    document.getElementById('deathStats').innerHTML =
      `<div class="stat-row"><span class="k">最深记录</span><span class="v">第 ${Meta.data.bestDepth} 层</span></div>` +
      `<div class="stat-row"><span class="k">本局发现</span><span class="v">${this.runDiscoveries} 件</span></div>` +
      `<div class="stat-row"><span class="k">获得回响</span><span class="v echo">+${this.runEcho}</span></div>`;
    this.showOverlay('death');
  },

  // ---------- 菜单 ----------
  toMenu() {
    this.state = 'menu';
    document.getElementById('hud').classList.remove('show');
    this.showOverlay('menu');
  },

  /* 选角:在数据驱动的职业列表中挑选本局身影 */
  openSelect() {
    this.state = 'select';
    const grid = document.getElementById('classList');
    grid.innerHTML = '';
    const last = LS.get('deep_echo_class') || CLASSES[0].id;
    this._selClass = last;
    for (const c of CLASSES) {
      const card = document.createElement('button');
      card.className = 'class-card' + (c.id === last ? ' selected' : '');
      card.style.setProperty('--cc', c.color);
      card.style.setProperty('--ca', c.accent);
      card.innerHTML =
        '<div class="cc-head"><span class="cc-name">' + c.name + '</span>' +
        '<span class="cc-tag">' + c.tag + '</span></div>' +
        '<div class="cc-bars">' +
          '<div class="cc-bar"><span>生命</span><div class="cc-track"><i style="width:' + c.meta.hp + '%"></i></div></div>' +
          '<div class="cc-bar"><span>速度</span><div class="cc-track"><i style="width:' + c.meta.spd + '%"></i></div></div>' +
          '<div class="cc-bar"><span>攻击</span><div class="cc-track"><i style="width:' + c.meta.atk + '%"></i></div></div>' +
        '</div>' +
        '<div class="cc-desc">' + c.desc + '</div>';
      // 选中:同时绑 click 与 touchstart(移动端最稳,见祭坛修复经验)
      const choose = () => {
        this._selClass = c.id;
        for (const el of grid.children) el.classList.remove('selected');
        card.classList.add('selected');
      };
      card.addEventListener('click', choose);
      card.addEventListener('touchstart', (e) => { e.preventDefault(); choose(); }, { passive: false });
      grid.appendChild(card);
    }
    this.showOverlay('select');
  },
  openCodex() {
    this.state = 'codex';
    const grid = document.getElementById('codexGrid');
    grid.innerHTML = '';
    for (const def of RELICS) {
      const found = Meta.isDiscovered(def.id);
      const cell = document.createElement('div');
      cell.className = 'codex-cell' + (found ? '' : ' locked');
      if (found) {
        const info = RELIC_INFO[def.id];
        cell.innerHTML = `<div style="font-size:22px;color:${def.color}">●</div><div class="cname">${info.name}</div><div class="cdesc">${info.desc}</div>`;
      } else {
        cell.innerHTML = `<div class="qm">?</div><div class="cdesc">未发现</div>`;
      }
      grid.appendChild(cell);
    }
    const total = RELICS.length, got = RELICS.filter(d => Meta.isDiscovered(d.id)).length;
    document.getElementById('codexProgress').textContent = `图鉴 ${got}/${total}`;
    this.showOverlay('codex');
  },
  openUnlock() { this.state = 'unlock'; this.renderUnlock(); this.showOverlay('unlock'); },
  renderUnlock() {
    document.getElementById('unlockStats').innerHTML =
      `<div class="stat-row"><span class="k">累计回响</span><span class="v echo">${Meta.data.echoes}</span></div>` +
      `<div class="stat-row"><span class="k">生命强化</span><span class="v">Lv.${Meta.hpLevel()} (+${Meta.bonusMaxHp()})</span></div>`;
    document.getElementById('btnBuyHp').textContent = `强化生命 (花费 ${Meta.hpCost()} 回响)`;
    document.getElementById('btnBuyHp').disabled = Meta.data.echoes < Meta.hpCost();
  },

  showOverlay(name) {
    for (const id of ['menu', 'death', 'codex', 'unlock', 'shrine', 'select'])
      document.getElementById(id).classList.toggle('show', id === name);
  },

  flashToast(text, kind) {
    const t = document.getElementById('toast');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show'), kind === 'discovery' ? 2600 : 1800);
  },

  updateHUD() {
    const p = this.player;
    document.getElementById('hpFill').style.width = (p.hp / p.maxHp * 100) + '%';
    // 受击红闪
    const hpWrap = document.getElementById('hpWrap');
    if (this._lastHp !== undefined && p.hp < this._lastHp) {
      hpWrap.classList.add('hit');
      clearTimeout(this._hpT);
      this._hpT = setTimeout(() => hpWrap.classList.remove('hit'), 180);
    }
    this._lastHp = p.hp;
    // 主动技能按钮(带冷却扫光)
    const abBtn = document.getElementById('abilityBtn');
    if (p.abilities.length) {
      const ab = p.abilities[0];
      const cd = p.abilityCd[ab.id] || 0;
      abBtn.style.display = 'flex';
      abBtn.style.opacity = cd > 0 ? '0.45' : '1';
      const pct = cd > 0 ? (cd / ab.cooldown) : 0;
      abBtn.style.background = 'conic-gradient(rgba(124,92,255,.28) ' + (pct * 360) + 'deg, rgba(34,211,238,.92) 0deg)';
    } else {
      abBtn.style.display = 'none';
    }
    // 首领血条
    const bb = document.getElementById('bossBar');
    if (this.boss && !this.boss.dead) {
      bb.classList.add('show');
      document.getElementById('bossFill').style.width = (this.boss.hp / this.boss.maxHp * 100) + '%';
    } else {
      bb.classList.remove('show');
    }
    // 低血量警示暗角
    document.getElementById('dangerVig').classList.toggle('show', p.hp / p.maxHp < 0.3);
    document.getElementById('chipFloor').textContent = '层 ' + this.floorNum;
    const cc = document.getElementById('chipClass');
    if (this.player && this.player.className) {
      cc.textContent = this.player.className;
      cc.style.color = this.player.classColor || 'var(--text)';
      cc.style.borderColor = 'color-mix(in srgb, ' + (this.player.classColor || '#7c5cff') + ' 45%, transparent)';
    }
    document.getElementById('chipEcho').textContent = '◈ ' + Meta.data.echoes;
    document.getElementById('chipShards').textContent = '◆ ' + (p.shards || 0);
    const bar = document.getElementById('relicBar');
    const n = p.relics.length;
    if (bar._n !== n) {
      bar.innerHTML = '';
      for (const r of p.relics) {
        const el = document.createElement('div');
        el.className = 'relic-icon' + (r.found ? ' found' : '');
        el.style.background = r.color + '33';
        el.style.borderColor = r.color;
        el.innerHTML = r.found ? '★' : '<span class="qm">?</span>';
        el.title = r.found ? RELIC_INFO[r.id].name : '未知遗物';
        bar.appendChild(el);
      }
      const added = n - this._relicCount;
      if (added > 0) {
        const kids = bar.children;
        for (let i = Math.max(0, kids.length - added); i < kids.length; i++) {
          const el2 = kids[i];
          el2.classList.add('new');
          setTimeout(() => el2.classList.remove('new'), 650);
        }
      }
      this._relicCount = n;
      bar._n = n;
    }
  },

  // ---------- 渲染 ----------
  render() {
    const ctx = this.ctx, W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);
    if (this.state === 'menu' || this.state === 'codex' || this.state === 'unlock' || this.state === 'select') {
      this.drawMenuBg(ctx, W, H);
      return;
    }
    if (this.state !== 'playing' && this.state !== 'dead' && this.state !== 'shrine') return;

    let sx = 0, sy = 0;
    if (this.shakeMag > 0) { sx = (Math.random() - 0.5) * this.shakeMag; sy = (Math.random() - 0.5) * this.shakeMag; }
    ctx.save();
    ctx.translate(-this.cam.x + sx, -this.cam.y + sy);

    this.drawWorld(ctx);
    // 遗物拾取:发光菱形宝石(浮动 + 辉光 + ?)
    for (const r of this.relicPickups) {
      const fl = Math.sin(this.time * 2 + r.x * 0.1);
      const yy = r.y + fl * 3;
      const s = 11 + (fl * 0.5 + 0.5) * 1.8;
      ctx.save();
      ctx.shadowBlur = 16; ctx.shadowColor = r.def.color;
      ctx.fillStyle = r.def.color;
      ctx.beginPath();
      ctx.moveTo(r.x, yy - s); ctx.lineTo(r.x + s * 0.8, yy);
      ctx.lineTo(r.x, yy + s); ctx.lineTo(r.x - s * 0.8, yy); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.fillStyle = 'rgba(11,15,26,.92)'; ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center'; ctx.fillText('?', r.x, yy + 4);
    }
    // 碎片拾取:闪烁菱形
    for (const s of this.shardPickups) {
      const yy = s.y + Math.sin(this.time * 3 + s.x) * 2;
      ctx.save(); ctx.shadowBlur = 8; ctx.shadowColor = '#fbbf24';
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.moveTo(s.x, yy - 6); ctx.lineTo(s.x + 4.5, yy);
      ctx.lineTo(s.x, yy + 6); ctx.lineTo(s.x - 4.5, yy); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    // 祭坛:脉动菱形 + 祭字
    for (const s of this.shrinePickups) {
      const fl = Math.sin(this.time * 2 + s.x) * 0.5 + 0.5;
      ctx.save();
      ctx.shadowBlur = 18; ctx.shadowColor = '#fbbf24';
      ctx.fillStyle = 'rgba(251,191,36,' + (0.55 + 0.4 * fl) + ')';
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 15); ctx.lineTo(s.x + 11, s.y);
      ctx.lineTo(s.x, s.y + 15); ctx.lineTo(s.x - 11, s.y); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#1b1206'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('祭', s.x, s.y + 5);
      // 引导提示:未触发的祭坛上方显示交互引导,让玩家知道可交互
      ctx.save();
      ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(251,191,36,.9)';
      ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('古老祭坛 · 靠近以抉择', s.x, s.y - 26);
      ctx.restore();
    }
    // 出口:脉冲旋转传送门
    const ex = World.exit, pulse = 0.5 + 0.5 * Math.sin(this.time * 3);
    ctx.save();
    ctx.shadowBlur = 22; ctx.shadowColor = '#7c5cff';
    const pg = ctx.createRadialGradient(ex.x, ex.y, 2, ex.x, ex.y, World.ts * 0.6);
    pg.addColorStop(0, 'rgba(200,185,255,0.85)');
    pg.addColorStop(1, 'rgba(124,92,255,0)');
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.arc(ex.x, ex.y, World.ts * 0.6 * (0.82 + 0.18 * pulse), 0, 7); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(167,139,250,.9)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(ex.x, ex.y, World.ts * 0.4, pulse * 0.6, pulse * 0.6 + Math.PI * 1.4); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('↓', ex.x, ex.y + 5);

    for (const e of this.enemies) e.draw(ctx);
    for (const b of this.bullets) b.draw(ctx);
    if (this.player) this.player.draw(ctx);
    for (const p of this.particles) p.draw(ctx);
    for (const d of this.dmgTexts) d.draw(ctx);
    for (const f of this.effects) f.draw(ctx);

    ctx.restore();
    // 洞穴光照(手电筒 + 暗角)
    this.drawLighting(ctx, W, H, this.player.x - this.cam.x + sx, this.player.y - this.cam.y + sy);
    this.drawJoystick(ctx);
  },

  drawWorld(ctx) {
    const ts = World.ts, tnow = this.time;
    const x0 = Math.max(0, Math.floor(this.cam.x / ts) - 1);
    const y0 = Math.max(0, Math.floor(this.cam.y / ts) - 1);
    const x1 = Math.min(World.W, Math.ceil((this.cam.x + window.innerWidth) / ts) + 1);
    const y1 = Math.min(World.H, Math.ceil((this.cam.y + window.innerHeight) / ts) + 1);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const t = World.grid[y][x];
        const px = x * ts, py = y * ts;
        if (t === World.T_WALL || t === World.T_HIDDEN || t === World.T_DOOR) {
          // 3D 斜角砖块
          ctx.fillStyle = '#1b2236'; ctx.fillRect(px, py, ts, ts);
          ctx.fillStyle = '#28324f'; ctx.fillRect(px, py, ts, 3);          // 顶高光
          ctx.fillStyle = '#28324f'; ctx.fillRect(px, py, 3, ts);          // 左高光
          ctx.fillStyle = '#10151f'; ctx.fillRect(px, py + ts - 3, ts, 3); // 底阴影
          ctx.fillStyle = '#10151f'; ctx.fillRect(px + ts - 3, py, 3, ts); // 右阴影
          if (t === World.T_HIDDEN) {
            // 隐藏墙:极弱接缝,奖励细心观察(不破坏探索难度)
            const a = 0.05 + 0.04 * Math.sin(tnow * 1.6 + (x + y));
            ctx.strokeStyle = 'rgba(255,255,255,' + a + ')';
            ctx.lineWidth = 1.5; ctx.strokeRect(px + 7, py + 7, ts - 14, ts - 14);
          }
          if (t === World.T_DOOR) {
            ctx.save();
            ctx.shadowBlur = 14; ctx.shadowColor = '#7c5cff';
            ctx.fillStyle = 'rgba(124,92,255,' + (0.45 + 0.25 * Math.sin(tnow * 3)) + ')';
            ctx.fillRect(px + ts / 2 - 4, py + 4, 8, ts - 8);
            ctx.restore();
          }
        } else {
          ctx.fillStyle = (t === World.T_EXIT) ? '#2a2150' : ((x + y) % 2 ? '#11172a' : '#0e1424');
          ctx.fillRect(px, py, ts, ts);
          if (t !== World.T_EXIT && ((x * 7 + y * 13) % 17 === 0)) {
            ctx.fillStyle = 'rgba(255,255,255,.025)';
            ctx.fillRect(px + ts * 0.5, py + ts * 0.5, 2, 2);
          }
        }
      }
    }
  },

  /* 洞穴光照:以玩家为中心的手电筒 + 边缘暗角 */
  drawLighting(ctx, W, H, sx, sy) {
    const R = Math.max(W, H) * 0.62;
    const g = ctx.createRadialGradient(sx, sy, R * 0.16, sx, sy, R);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.58, 'rgba(5,7,13,0.34)');
    g.addColorStop(1, 'rgba(5,7,13,0.84)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  },

  drawJoystick(ctx) {
    const j = Input.joyVisual();
    if (!j) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(j.ox, j.oy, 56, 0, 7); ctx.stroke();
    ctx.strokeStyle = 'rgba(124,92,255,.45)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(j.ox, j.oy, 56, 0, 7); ctx.stroke();
    const kx = j.ox + j.vx * 46, ky = j.oy + j.vy * 46;
    ctx.shadowBlur = 18; ctx.shadowColor = '#7c5cff';
    const kg = ctx.createRadialGradient(kx, ky, 2, kx, ky, 26);
    kg.addColorStop(0, 'rgba(167,139,250,.95)');
    kg.addColorStop(1, 'rgba(124,92,255,.25)');
    ctx.fillStyle = kg;
    ctx.beginPath(); ctx.arc(kx, ky, 26, 0, 7); ctx.fill();
    ctx.restore();
  },

  drawMenuBg(ctx, W, H) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    const dark = document.documentElement.getAttribute('data-theme') === 'light';
    g.addColorStop(0, dark ? '#dfe5f3' : '#131a2b');
    g.addColorStop(1, dark ? '#eef1f8' : '#0b0f1a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // 流动光尘
    if (!this.motes) {
      this.motes = [];
      for (let i = 0; i < 28; i++)
        this.motes.push({ x: Math.random() * W, y: Math.random() * H, r: 1 + Math.random() * 2.4, vy: 0.12 + Math.random() * 0.4, ph: Math.random() * 6 });
    }
    ctx.save();
    for (const m of this.motes) {
      m.y -= m.vy;
      if (m.y < -10) { m.y = H + 10; m.x = Math.random() * W; }
      ctx.globalAlpha = 0.12 + 0.14 * Math.sin(this.time * 1.5 + m.ph);
      ctx.fillStyle = dark ? '#7c5cff' : '#a78bfa';
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, 7); ctx.fill();
    }
    ctx.restore();
  },
};

window.addEventListener('load', () => Game.init());
