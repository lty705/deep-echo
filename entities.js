/* ============================================================
 * 实体系统 (Entities)
 * Player / Enemy(多类型) / Bullet / Particle / DamageText
 * 命中反馈(顿帧/震屏)通过全局 Game 接口触发。
 * 坐标均为世界像素;绘制时由 game.js 统一做相机平移。
 * ============================================================ */

function moveEntity(ent, dx, dy) {
  const r = ent.radius;
  let nx = ent.x + dx;
  let sx = Math.sign(dx);
  if (!World.solidAtPx(nx + sx * r, ent.y)) ent.x = nx;
  let ny = ent.y + dy;
  let sy = Math.sign(dy);
  if (!World.solidAtPx(ent.x, ny + sy * r)) ent.y = ny;
}

/* ============================================================
 * 形状绘制辅助:用矢量图形(多边形/有机团块)替代纯圆,
 * 让每个实体有独立剪影与辨识度 —— 告别"全都像个球"。
 * ============================================================ */
function regularPoly(ctx, x, y, r, sides, rot) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function blobPath(ctx, x, y, r, t, wob, sides, phase) {
  ctx.beginPath();
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const rr = r * (1 + wob * Math.sin(a * 3 + t * 2 + phase));
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function shadeColor(hex, amt) {
  let c = (hex || '#ffffff').replace('#', '');
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  let r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  const p = amt / 100;
  const mix = (v, target) => Math.round(v + (target - v) * (p < 0 ? 1 + p : p));
  if (p < 0) { r = mix(r, 0); g = mix(g, 0); b = mix(b, 0); }
  else { r = mix(r, 255); g = mix(g, 255); b = mix(b, 255); }
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function drawEnemyEyes(ctx, x, y, r, ang) {
  const ex = Math.cos(ang), ey = Math.sin(ang);
  const px = -ey, py = ex;
  const eo = r * 0.35, esp = r * 0.42;
  const er = Math.max(1.6, r * 0.17);
  ctx.fillStyle = '#0b0f1a';
  for (const s of [1, -1]) {
    ctx.beginPath();
    ctx.arc(x + ex * eo + px * esp * s, y + ey * eo + py * esp * s, er, 0, 7); ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  for (const s of [1, -1]) {
    ctx.beginPath();
    ctx.arc(x + ex * eo + px + px * esp * s - ex * 1.2, y + ey * eo + py * esp * s - ey * 1.2, er * 0.4, 0, 7); ctx.fill();
  }
}

class Player {
  constructor(x, y, maxHp, classId) {
    const cls = getClass(classId) || CLASSES[0];
    this.classId = cls.id;
    this.className = cls.name;
    this.classColor = cls.color;
    this.classAccent = cls.accent;
    this.classMods = cls.mods || {};
    this.classFlags = cls.flags || {};
    this.x = x; this.y = y;
    this.radius = CONFIG.player.radius * (this.classMods.radiusMul || 1);
    this.maxHp = maxHp; this.hp = maxHp;
    // 职业派生属性(遗物 recompute 会在此基础上叠加,而非覆盖)
    this.attackDmg = CONFIG.player.attackDamage * (this.classMods.attackMul || 1);
    this.attackInterval = CONFIG.player.attackInterval * (this.classMods.attackIntervalMul || 1);
    this.facing = { x: 0, y: 1 };
    this.attackCd = 0; this.dashTimer = 0; this.dashCdTimer = 0;
    this.iframes = 0; this.shield = 0; this.touchCd = 0;
    this.dashDir = { x: 0, y: 1 };
    this.parryTimer = 0;     // 完美闪避窗口(闪避启动瞬间)
    this.attackAnim = 0;     // 攻击挥动动画计时(用于前冲与身体微胀)
    this.alive = true;
    this.relics = [];        // 已佩戴(名字隐藏)
    this.abilities = [];     // 主动技能(来自 active 遗物)
    this.abilityCd = {};     // id -> 剩余冷却(秒)
    // 派生属性(由 Relics.recompute 写入)
    this.speedMul = 1; this.dashCdMul = 1;
    this.shieldOnDash = false; this.ranged = false;
    this.lifesteal = 0; this.reflect = 0; this.touchDmg = 0;
    this.surviveTimer = 0;   // 用于 stat 类遗物"存活推断"
  }

  recompute() { Relics.recompute(this); }

  update(dt) {
    if (!this.alive) return;
    this.attackCd = Math.max(0, this.attackCd - dt);
    this.dashCdTimer = Math.max(0, this.dashCdTimer - dt);
    this.iframes = Math.max(0, this.iframes - dt);
    this.shield = Math.max(0, this.shield - dt);
    this.touchCd = Math.max(0, this.touchCd - dt);
    this.parryTimer = Math.max(0, this.parryTimer - dt);
    this.attackAnim = Math.max(0, this.attackAnim - dt);
    this.surviveTimer += dt;
    for (const id in this.abilityCd) this.abilityCd[id] = Math.max(0, this.abilityCd[id] - dt);

    // 闪避输入
    const dv = Input.consumeDash();
    if (dv && this.dashCdTimer <= 0) {
      this.dashTimer = CONFIG.player.dashDuration;
      this.iframes = Math.max(this.iframes, CONFIG.player.dashIframes);
      this.dashCdTimer = CONFIG.player.dashCooldown * this.dashCdMul;
      this.dashDir = dv;
      this.facing = { x: dv.x, y: dv.y };
      this.parryTimer = CONFIG.combat.parryWindow;  // 启动瞬间进入完美闪避窗口
      Relics.onDash(this);     // 回响护符:获得护盾 + 推断
    }

    // 移动
    let vx = 0, vy = 0;
    if (this.dashTimer > 0) {
      vx = this.dashDir.x * CONFIG.player.dashSpeed;
      vy = this.dashDir.y * CONFIG.player.dashSpeed;
      this.dashTimer -= dt;
    } else {
      const m = Input.move;
      if (m.x || m.y) {
        const l = Math.hypot(m.x, m.y);
        const s = CONFIG.player.speed * this.speedMul;
        vx = (m.x / l) * s; vy = (m.y / l) * s;
        this.facing = { x: m.x / l, y: m.y / l };
      }
    }
    moveEntity(this, vx * dt * 60, vy * dt * 60);

    // 攻击
    if (Input.consumeAttack() && this.attackCd <= 0) this.attack();

    // stat 类遗物:存活足够久即推断
    Relics.checkSurvive(this);
  }

  attack() {
    this.attackCd = this.attackInterval;
    this.attackAnim = 0.16;            // 触发挥砍动画
    this.tryBreakWalls();
    const range = CONFIG.player.attackRange * World.ts;
    if (this.ranged) {
      Game.spawnPlayerBullet(this.x, this.y, this.facing.x, this.facing.y, this.attackDmg);
      Game.hitStop(CONFIG.player.hitStop);
      Game.shake(3);
      Game.addSlash(this.x, this.y, this.facing.x, this.facing.y);
      return;
    }
    let hitAny = false;
    for (const e of Game.enemies) {
      const d = Math.hypot(e.x - this.x, e.y - this.y);
      if (d <= range + e.radius) {
        e.takeDamage(this.attackDmg, this.x, this.y);
        if (this.lifesteal > 0) this.heal(this.attackDmg * this.lifesteal);
        hitAny = true;
      }
    }
    Game.addSlash(this.x, this.y, this.facing.x, this.facing.y);
    Game.hitStop(CONFIG.player.hitStop);
    Game.shake(hitAny ? 7 : 2);
  }

  tryBreakWalls() {
    const pt = { x: Math.floor(this.x / World.ts), y: Math.floor(this.y / World.ts) };
    const R = Math.ceil(CONFIG.player.attackRange);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (Math.hypot(dx, dy) > R + 0.5) continue;
        const tx = pt.x + dx, ty = pt.y + dy;
        const t = World.tileAt(tx, ty);
        if (t === World.T_HIDDEN || t === World.T_DOOR) Game.breakWallAt(tx, ty);
      }
    }
  }

  heal(n) {
    if (n <= 0) return;
    this.hp = Math.min(this.maxHp, this.hp + n);
    Relics.onHeal(this); // 渴血刃:治疗即推断
  }

  takeDamage(dmg, fromX, fromY) {
    if (!this.alive) return;
    // 完美闪避:窗口内顶掉伤害,触发反震
    if (this.parryTimer > 0) { this.doParry(); return; }
    if (this.iframes > 0) return;
    if (this.shield > 0) {
      this.shield = 0;
      Relics.onBlock(this);   // 回响护符:格挡即推断
      Game.shake(4);
      return;
    }
    this.hp -= dmg;
    this.iframes = 0.45;
    Game.hitStop(CONFIG.player.hitStop);
    Game.shake(7);
    Game.addDamageText(this.x, this.y - this.radius, Math.round(dmg), '#f87171');
    if (this.reflect > 0 && fromX !== undefined) {
      const e = Game.enemyAt(fromX, fromY);
      if (e) e.takeDamage(this.reflect);
      Relics.onReflect(this);
    }
    if (this.hp <= 0) { this.hp = 0; this.alive = false; Game.onPlayerDeath(); }
  }

  doParry() {
    this.parryTimer = 0;
    this.iframes = Math.max(this.iframes, CONFIG.combat.parryIframes);
    Game.triggerParry(this.x, this.y);
  }

  draw(ctx) {
    const t = Game.time;
    const C = this.classColor, A = this.classAccent;
    // 护盾环
    if (this.shield > 0) {
      ctx.save();
      ctx.shadowBlur = 18; ctx.shadowColor = A;
      ctx.strokeStyle = A; ctx.lineWidth = 3;
      regularPoly(ctx, this.x, this.y, this.radius + 6, 6, t * 0.8);
      ctx.stroke();
      ctx.restore();
    }
    // 闪避三层残影(拖尾)
    if (this.dashTimer > 0) {
      for (let k = 1; k <= 3; k++) {
        ctx.globalAlpha = 0.18 / k;
        ctx.fillStyle = A;
        ctx.beginPath();
        ctx.arc(this.x - this.dashDir.x * 9 * k, this.y - this.dashDir.y * 9 * k, this.radius, 0, 7);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // 攻击前冲 + 身体微胀
    const lunge = this.attackAnim > 0 ? this.attackAnim / 0.16 : 0;
    const lx = this.facing.x * lunge * 6;
    const ly = this.facing.y * lunge * 6;
    const cx = this.x + lx, cy = this.y + ly;
    const breathe = 1 + Math.sin(t * 4) * 0.05;
    const r = this.radius * breathe * (1 + lunge * 0.12);
    const fa = Math.atan2(this.facing.y, this.facing.x);

    // ① 前向光锥(洞穴手电意象)——从核心射出的半透明锥形光束
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(fa);
    const beam = ctx.createLinearGradient(0, 0, r * 3.6, 0);
    beam.addColorStop(0, 'rgba(199,210,254,0.32)');
    beam.addColorStop(1, 'rgba(199,210,254,0)');
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(r * 3.6, -r * 1.15);
    ctx.lineTo(r * 3.6, r * 1.15);
    ctx.closePath();
    ctx.fill();
    // 指向箭头(明确朝向)
    ctx.fillStyle = A;
    ctx.beginPath();
    ctx.moveTo(r * 1.2, 0); ctx.lineTo(r * 0.45, -r * 0.5); ctx.lineTo(r * 0.45, r * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // ② 旋转水晶外壳(双菱形)—— 几何感,不再是球;颜色随职业
    ctx.save();
    ctx.translate(cx, cy);
    ctx.shadowBlur = 14; ctx.shadowColor = C;
    ctx.rotate(t * 0.8);
    ctx.strokeStyle = C; ctx.lineWidth = 2; ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.55); ctx.lineTo(r * 1.1, 0); ctx.lineTo(0, r * 1.55); ctx.lineTo(-r * 1.1, 0);
    ctx.closePath(); ctx.stroke();
    ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = A; ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.05); ctx.lineTo(r * 0.8, 0); ctx.lineTo(0, r * 1.05); ctx.lineTo(-r * 0.8, 0);
    ctx.closePath(); ctx.stroke();
    ctx.restore();

    // ③ 核心光源(缩小,作为"灯芯"而非球身)
    const g = ctx.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, r * 0.85);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.5, C); g.addColorStop(1, 'rgba(124,92,255,0)');
    ctx.save();
    ctx.shadowBlur = 16; ctx.shadowColor = C;
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.85, 0, 7); ctx.fill();
    ctx.restore();
  }
}

class Enemy {
  constructor(x, y, opts = {}) {
    this.x = x; this.y = y; this.radius = CONFIG.enemy.radius;
    this.type = opts.type || 'walker';
    this.elite = !!opts.elite;
    this.boss = !!opts.boss;
    this.gen = opts.gen || 0;          // 分裂体代数
    let hpMul = opts.hpMul || 1;
    let dmgMul = opts.dmgMul || 1;
    let speed = CONFIG.enemy.speed;
    if (this.boss) {
      hpMul *= CONFIG.enemy.boss.hpMul; dmgMul *= CONFIG.enemy.boss.dmgMul;
      this.radius = CONFIG.enemy.boss.radius; speed = CONFIG.enemy.boss.speed;
    } else if (this.elite) {
      hpMul *= CONFIG.enemy.elite.hpMul; dmgMul *= CONFIG.enemy.elite.dmgMul;
      this.radius = CONFIG.enemy.elite.radius; speed *= CONFIG.enemy.elite.speedMul;
    } else if (this.type === 'splitter' && this.gen > 0) {
      hpMul *= CONFIG.enemy.splitter.childHpMul;
      dmgMul *= CONFIG.enemy.splitter.childDmgMul;
      this.radius = CONFIG.enemy.splitter.childRadius;
      speed *= CONFIG.enemy.splitter.childSpeed;
    }
    this.maxHp = CONFIG.enemy.hp * hpMul;
    this.hp = this.maxHp;
    this.speed = speed;
    this.contactDamage = CONFIG.enemy.contactDamage * dmgMul *
      (this.type === 'charger' ? CONFIG.enemy.charger.dmgMul : 1);
    this.shooter = (this.type === 'shooter' || this.boss);
    this.shootCd = (this.boss ? CONFIG.enemy.boss.shootInterval : CONFIG.enemy.shootInterval) * (0.5 + Math.random());
    this.contactCd = 0;
    this.flash = 0;
    this.squashT = 0;        // 命中挤压动画计时
    this.hitAng = 0;         // 受击方向(用于定向挤压)
    this.dead = false;
    // 状态机
    this.state = 'chase';
    this.stateT = 0;
    this.dashVX = 0; this.dashVY = 0;
    this.shieldDir = 0;                 // 炮台朝向
    this.chargeCd = CONFIG.enemy.boss.chargeCd || 0;
    this.summonCd = CONFIG.enemy.boss.summonCd || 0;
    this.color = this._color();
  }

  _color() {
    switch (this.type) {
      case 'shooter': return '#fb7185';
      case 'charger': return '#f59e0b';
      case 'splitter': return '#a3e635';
      case 'turret': return '#f472b6';
      case 'boss': return '#c084fc';
      default: return '#f87171';
    }
  }

  update(dt, player) {
    if (this.dead) return;
    this.contactCd = Math.max(0, this.contactCd - dt);
    this.flash = Math.max(0, this.flash - dt);
    this.squashT = Math.max(0, this.squashT - dt);
    let dx = player.x - this.x, dy = player.y - this.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;

    if (this.type === 'turret') this._updateTurret(dt, player, ux, uy, d);
    else if (this.type === 'charger') this._updateCharger(dt, player, ux, uy, d);
    else if (this.boss) this._updateBoss(dt, player, ux, uy, d);
    else this._updateWalker(dt, ux, uy, d);

    // 接触伤害(炮台固定不接触)
    if (this.type !== 'turret' && d < this.radius + player.radius && this.contactCd <= 0) {
      this.contactCd = CONFIG.enemy.contactCd;
      player.takeDamage(this.contactDamage, this.x, this.y);
    }
  }

  _updateWalker(dt, ux, uy, d) {
    const sp = this.speed;
    moveEntity(this, ux * sp * dt * 60, uy * sp * dt * 60);
    if (this.shooter && d < World.ts * 7) this._shoot(dt, ux, uy, CONFIG.enemy.bulletDamage);
  }

  _updateCharger(dt, player, ux, uy, d) {
    const C = CONFIG.enemy.charger;
    this.stateT -= dt;
    if (this.state === 'chase') {
      moveEntity(this, ux * this.speed * dt * 60, uy * this.speed * dt * 60);
      if (d < World.ts * 4.2) { this.state = 'windup'; this.stateT = C.windup; }
    } else if (this.state === 'windup') {
      // 蓄力:停住发光,锁定方向
      this.dashVX = ux; this.dashVY = uy;
      if (this.stateT <= 0) { this.state = 'dash'; this.stateT = C.dashTime; }
    } else if (this.state === 'dash') {
      moveEntity(this, this.dashVX * C.dashSpeed * dt * 60, this.dashVY * C.dashSpeed * dt * 60);
      if (this.stateT <= 0) { this.state = 'recover'; this.stateT = C.cd; }
    } else { // recover
      moveEntity(this, ux * this.speed * 0.4 * dt * 60, uy * this.speed * 0.4 * dt * 60);
      if (this.stateT <= 0) this.state = 'chase';
    }
  }

  _updateTurret(dt, player, ux, uy, d) {
    // 缓慢转向玩家,正面护盾
    const target = Math.atan2(uy, ux);
    let diff = target - this.shieldDir;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.shieldDir += diff * Math.min(1, dt * 3);
    if (d < World.ts * CONFIG.enemy.turret.range) this._shoot(dt, ux, uy, CONFIG.enemy.turret.bulletDamage, CONFIG.enemy.turret.shootInterval);
  }

  _updateBoss(dt, player, ux, uy, d) {
    const B = CONFIG.enemy.boss;
    // 缓慢逼近
    if (this.state !== 'charge') moveEntity(this, ux * this.speed * dt * 60, uy * this.speed * dt * 60);
    // 径向弹幕
    this.shootCd -= dt;
    if (this.shootCd <= 0) {
      this.shootCd = B.shootInterval;
      for (let i = 0; i < B.burst; i++) {
        const a = (i / B.burst) * Math.PI * 2 + Game.time;
        Game.spawnEnemyBullet(this.x, this.y, Math.cos(a), Math.sin(a), CONFIG.enemy.bulletDamage);
      }
    }
    // 召唤分裂体
    this.summonCd -= dt;
    if (this.summonCd <= 0) {
      this.summonCd = B.summonCd;
      Game.spawnSplitter(this.x + 20, this.y, 1);
      Game.spawnSplitter(this.x - 20, this.y, 1);
    }
    // 冲撞
    this.chargeCd -= dt;
    if (this.chargeCd <= 0 && this.state !== 'charge') {
      this.chargeCd = B.chargeCd; this.state = 'charge'; this.stateT = 0.5;
      this.dashVX = ux; this.dashVY = uy;
    }
    if (this.state === 'charge') {
      this.stateT -= dt;
      moveEntity(this, this.dashVX * this.speed * 4 * dt * 60, this.dashVY * this.speed * 4 * dt * 60);
      if (this.stateT <= 0) this.state = 'idle';
    }
  }

  _shoot(dt, ux, uy, dmg, interval) {
    const iv = interval || CONFIG.enemy.shootInterval;
    this.shootCd -= dt;
    if (this.shootCd <= 0) {
      this.shootCd = iv;
      Game.spawnEnemyBullet(this.x, this.y, ux, uy, dmg);
    }
  }

  takeDamage(dmg, ox, oy) {
    // 炮台正面护盾:来自前方的伤害被挡
    if (this.type === 'turret' && ox !== undefined) {
      const ang = Math.atan2(oy - this.y, ox - this.x);
      let diff = ang - this.shieldDir;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) < CONFIG.enemy.turret.shieldArc / 2) {
        Game.addParticle(this.x + Math.cos(ang) * this.radius, this.y + Math.sin(ang) * this.radius, '#fde68a');
        Game.shake(2);
        return;
      }
    }
    this.hp -= dmg;
    this.flash = 0.12;
    this.squashT = 0.14;                       // 命中挤压
    if (ox !== undefined) {
      const a = Math.atan2(this.y - oy, this.x - ox);
      this.hitAng = a;
      const k = this.boss ? 4 : 8;             // 击退力度(体型越大越钝)
      moveEntity(this, Math.cos(a) * k, Math.sin(a) * k);
      Game.addImpact(this.x, this.y, this.color, Math.cos(a), Math.sin(a));
    } else {
      Game.addImpact(this.x, this.y, this.color, 0, -1);
    }
    Game.addDamageText(this.x, this.y - this.radius, Math.round(dmg), '#fbbf24');
    if (this.hp <= 0 && !this.dead) {
      this.dead = true;
      if (this.type === 'splitter' && this.gen < CONFIG.enemy.splitter.generations)
        Game.spawnSplitter(this.x, this.y, this.gen + 1);
      Game.onEnemyDeath(this);
    }
  }

  draw(ctx) {
    const flash = this.flash > 0;
    const base = this.color;
    const sq = this.squashT > 0 ? 1 + (this.squashT / 0.14) * 0.18 : 1;  // 命中挤压
    const t = Game.time;
    const r = this.radius;
    const ang = Math.atan2(Game.player.y - this.y, Game.player.x - this.x);
    const fillBase = flash ? '#ffffff' : base;

    // 类型专属底纹 / 预警(在变换前绘制)
    if (this.type === 'turret') this._drawShield(ctx);
    if (this.type === 'charger' && this.state === 'windup') {
      const p = 1 - this.stateT / CONFIG.enemy.charger.windup;
      ctx.save(); ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#fde68a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(this.x, this.y, r + 6 + p * 10, 0, 7); ctx.stroke();
      ctx.restore();
    }
    // 精英:旋转金色六边环
    if (this.elite) {
      ctx.save();
      ctx.strokeStyle = 'rgba(251,191,36,' + (0.5 + 0.4 * Math.sin(t * 4)) + ')';
      ctx.lineWidth = 3;
      regularPoly(ctx, this.x, this.y, r + 9, 6, t * 0.5);
      ctx.stroke();
      ctx.restore();
    }

    // 主体(在受击方向挤压)
    ctx.save();
    ctx.translate(this.x, this.y);
    if (this.squashT > 0) {
      ctx.rotate(this.hitAng);
      ctx.scale(sq, 2 - sq);
      ctx.rotate(-this.hitAng);
    } else {
      ctx.scale(sq, sq);
    }
    ctx.shadowBlur = this.boss ? 18 : 8;
    ctx.shadowColor = flash ? '#fff' : base;

    if (this.type === 'walker') {
      // 蠕动团块:有机波浪边 + 暗色内核
      blobPath(ctx, 0, 0, r, t, 0.14, 9, 0);
      ctx.fillStyle = fillBase; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = shadeColor(base, -28);
      blobPath(ctx, 0, 0, r * 0.6, t, 0.18, 7, 1.5); ctx.fill();
    } else if (this.type === 'shooter') {
      // 眼球怪:外球 + 大瞳孔 + 虹膜环
      ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fillStyle = fillBase; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#0b0f1a';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, 7); ctx.fill();
      ctx.fillStyle = flash ? '#fff' : '#fde68a';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.30, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.78, 0, 7); ctx.stroke();
    } else if (this.type === 'charger') {
      // 箭头/水滴,朝玩家;蓄力时凝聚能量点
      ctx.rotate(ang);
      const grd = ctx.createLinearGradient(-r, 0, r, 0);
      grd.addColorStop(0, shadeColor(base, -22));
      grd.addColorStop(1, fillBase);
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(r * 1.3, 0);
      ctx.lineTo(-r * 0.75, -r * 0.9);
      ctx.lineTo(-r * 0.3, 0);
      ctx.lineTo(-r * 0.75, r * 0.9);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      if (this.state === 'windup') {
        ctx.fillStyle = '#fff';
        const er = r * 0.32 * (1 - this.stateT / CONFIG.enemy.charger.windup);
        ctx.beginPath(); ctx.arc(0, 0, er, 0, 7); ctx.fill();
      }
    } else if (this.type === 'splitter') {
      // 晶体簇:六边形宝石 + 亮核
      ctx.fillStyle = fillBase;
      regularPoly(ctx, 0, 0, r, 6, t * 0.6); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = flash ? '#fff' : shadeColor(base, 34);
      regularPoly(ctx, 0, 0, r * 0.5, 6, t * 0.6); ctx.fill();
    } else if (this.type === 'turret') {
      // 六边形底座 + 暗核 + 能量点
      ctx.fillStyle = fillBase;
      regularPoly(ctx, 0, 0, r, 6, 0); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(11,15,26,.6)';
      regularPoly(ctx, 0, 0, r * 0.45, 6, 0); ctx.fill();
      ctx.fillStyle = flash ? '#fff' : '#fde68a';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.22, 0, 7); ctx.fill();
    } else { // boss
      // 巨大虚空兽:暗核 + 亮边 + 中央巨眼
      blobPath(ctx, 0, 0, r, t, 0.10, 10, 0.7);
      ctx.fillStyle = flash ? '#fff' : '#2a1a4a'; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = base; ctx.lineWidth = 3;
      blobPath(ctx, 0, 0, r * 0.92, t, 0.10, 10, 0.7); ctx.stroke();
      ctx.fillStyle = '#0b0f1a';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.4, 0, 7); ctx.fill();
      ctx.fillStyle = flash ? '#fff' : '#fde68a';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.2, 0, 7); ctx.fill();
    }
    ctx.restore();

    // Boss 王冠尖刺(外置,不随挤压变形)
    if (this.boss) {
      ctx.save();
      ctx.fillStyle = '#fde68a';
      for (let i = 0; i < 8; i++) {
        const a = i / 8 * Math.PI * 2 + t * 0.6;
        ctx.beginPath();
        ctx.moveTo(this.x + Math.cos(a) * (r + 4), this.y + Math.sin(a) * (r + 4));
        ctx.lineTo(this.x + Math.cos(a) * (r + 14), this.y + Math.sin(a) * (r + 14));
        ctx.lineTo(this.x + Math.cos(a + 0.16) * (r + 4), this.y + Math.sin(a + 0.16) * (r + 4));
        ctx.fill();
      }
      ctx.restore();
    }
    // 朝向玩家的双眼(中央已有眼的射手/Boss 除外)
    if (this.type === 'walker' || this.type === 'splitter' || this.type === 'charger') {
      drawEnemyEyes(ctx, this.x, this.y, r, ang);
    }
    // 血条
    if (this.hp < this.maxHp && !this.boss) {
      const w = r * 2;
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillRect(this.x - r, this.y - r - 9, w, 3);
      ctx.fillStyle = this.elite ? '#fbbf24' : '#4ade80';
      ctx.fillRect(this.x - r, this.y - r - 9, w * (this.hp / this.maxHp), 3);
    }
  }

  _drawShield(ctx) {
    ctx.save();
    ctx.strokeStyle = 'rgba(253,230,138,.55)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius + 7, this.shieldDir - CONFIG.enemy.turret.shieldArc / 2,
      this.shieldDir + CONFIG.enemy.turret.shieldArc / 2);
    ctx.stroke();
    ctx.restore();
  }
}

class Bullet {
  constructor(x, y, vx, vy, dmg, fromPlayer) {
    this.x = x; this.y = y; this.vx = vx; this.vy = vy;
    this.dmg = dmg; this.fromPlayer = fromPlayer;
    this.radius = CONFIG.enemy.bulletRadius; this.dead = false;
  }
  update(dt) {
    this.x += this.vx * dt * 60; this.y += this.vy * dt * 60;
    if (this.fromPlayer && Math.random() < 0.6)
      Game.addSpark(this.x, this.y, '#fbbf24', (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6);
    if (World.solidAtPx(this.x, this.y)) { this.dead = true; return; }
    if (this.fromPlayer) {
      for (const e of Game.enemies) {
        if (Math.hypot(e.x - this.x, e.y - this.y) < e.radius + this.radius) {
          if (Game.player.ranged) Relics.onRangedHit(Game.player); // 余烬:远程命中即推断
          e.takeDamage(this.dmg, this.x, this.y);
          if (Game.player.lifesteal > 0) Game.player.heal(this.dmg * Game.player.lifesteal);
          Game.addImpact(this.x, this.y, '#fde68a', this.vx, this.vy);
          this.dead = true; break;
        }
      }
    } else {
      const p = Game.player;
      if (p.alive && Math.hypot(p.x - this.x, p.y - this.y) < p.radius + this.radius) {
        p.takeDamage(this.dmg); this.dead = true;
      }
    }
  }
  draw(ctx) {
    const ang = Math.atan2(this.vy, this.vx);
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(ang);
    ctx.shadowBlur = 10;
    ctx.shadowColor = this.fromPlayer ? '#fbbf24' : '#fb7185';
    if (this.fromPlayer) {
      // 余烬火球:拖尾彗星 + 亮核
      const grd = ctx.createLinearGradient(-this.radius * 1.8, 0, this.radius, 0);
      grd.addColorStop(0, 'rgba(251,146,60,0)');
      grd.addColorStop(1, '#fde68a');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(-this.radius * 0.6, 0, this.radius * 1.8, this.radius, 0, 0, 7);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(this.radius * 0.2, 0, this.radius * 0.55, 0, 7); ctx.fill();
    } else {
      // 敌弹:暗红核心 + 亮边
      ctx.fillStyle = '#7f1d2e';
      ctx.beginPath(); ctx.arc(0, 0, this.radius, 0, 7); ctx.fill();
      ctx.fillStyle = '#fecdd3';
      ctx.beginPath(); ctx.arc(0, 0, this.radius * 0.55, 0, 7); ctx.fill();
    }
    ctx.restore();
  }
}

class Particle {
  constructor(x, y, color) {
    this.x = x; this.y = y; this.color = color;
    const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 3;
    this.vx = Math.cos(a) * s; this.vy = Math.sin(a) * s;
    this.life = 0.4 + Math.random() * 0.3; this.t = this.life;
  }
  update(dt) { this.x += this.vx * dt * 60; this.y += this.vy * dt * 60; this.t -= dt; }
  get dead() { return this.t <= 0; }
  draw(ctx) {
    ctx.globalAlpha = Math.max(0, this.t / this.life);
    ctx.fillStyle = this.color;
    ctx.beginPath(); ctx.arc(this.x, this.y, 2.5, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

class DamageText {
  constructor(x, y, text, color) { this.x = x; this.y = y; this.text = text; this.color = color; this.t = 0.8; }
  update(dt) { this.y -= dt * 30; this.t -= dt; }
  get dead() { return this.t <= 0; }
  draw(ctx) {
    const a = Math.max(0, this.t / 0.8);
    const scale = 1 + Math.max(0, (this.t - 0.6)) / 0.2 * 0.4;
    ctx.globalAlpha = a;
    const fsize = Math.round(16 * scale);
    ctx.font = 'bold ' + fsize + 'px sans-serif'; ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.strokeText(this.text, this.x, this.y);
    ctx.fillStyle = this.color;
    ctx.fillText(this.text, this.x, this.y);
    ctx.globalAlpha = 1;
  }
}

/* ============================================================
 * 打击感特效层
 * Slash 近战挥砍弧光 / HitRing 命中冲击环 / Spark 定向火花
 * 全部在 Game.effects / Game.particles 中统一更新与清理。
 * ============================================================ */

/* 近战挥砍弧光 —— 攻击瞬间在朝向方向扫出一道由内向外扩展的弧形光刃 */
class Slash {
  constructor(x, y, dx, dy) {
    this.x = x; this.y = y;
    this.ang = Math.atan2(dy, dx);
    this.life = 0.18; this.t = this.life;
    this.reach = CONFIG.player.attackRange * World.ts * 0.95;
  }
  update(dt) { this.t -= dt; }
  get dead() { return this.t <= 0; }
  draw(ctx) {
    const p = 1 - this.t / this.life;        // 0→1
    const a = Math.sin(p * Math.PI);          // 淡入淡出
    const spread = 1.2;                        // 弧张角(弧度)
    const r = this.reach * (0.5 + 0.5 * p);    // 由内向外扫出
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.ang);
    ctx.lineCap = 'round';
    // 外层渐变光弧
    const grad = ctx.createLinearGradient(0, 0, r, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.6, 'rgba(199,210,254,0.9)');
    grad.addColorStop(1, 'rgba(124,92,255,0.95)');
    ctx.globalAlpha = a * 0.9;
    ctx.strokeStyle = grad; ctx.lineWidth = 6 - 3.5 * p;
    ctx.beginPath(); ctx.arc(0, 0, r, -spread / 2, spread / 2); ctx.stroke();
    // 内层亮线
    ctx.globalAlpha = a * 0.6;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.82, -spread / 2, spread / 2); ctx.stroke();
    ctx.restore();
  }
}

/* 命中冲击环 —— 敌人受击时身上爆开的扩散光环,并抛出定向火花 */
class HitRing {
  constructor(x, y, color, dx, dy) {
    this.x = x; this.y = y;
    this.color = color || '#ffffff';
    this.ang = Math.atan2(dy, dx);
    this.life = 0.26; this.t = this.life;
    this.n = 8;
    this._spawned = false;
  }
  update(dt) {
    this.t -= dt;
    if (this._spawned) return;
    this._spawned = true;
    for (let i = 0; i < this.n; i++) {
      const a = this.ang + (Math.random() - 0.5) * 1.5;
      const sp = 2 + Math.random() * 3.8;
      Game.particles.push(new Spark(this.x, this.y, Math.cos(a) * sp, Math.sin(a) * sp, this.color));
    }
  }
  get dead() { return this.t <= 0; }
  draw(ctx) {
    const p = 1 - this.t / this.life;
    const r = 6 + p * 24;
    const a = (1 - p) * 0.85;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = this.color; ctx.lineWidth = 2.6 - 1.6 * p;
    ctx.beginPath(); ctx.arc(this.x, this.y, r, 0, 7); ctx.stroke();
    ctx.restore();
  }
}

/* 定向火花粒子 —— 比基础 Particle 更具速度感与方向性(用于命中爆点与子弹拖尾) */
class Spark {
  constructor(x, y, vx, vy, color) {
    this.x = x; this.y = y; this.vx = vx; this.vy = vy;
    this.color = color;
    this.life = 0.3 + Math.random() * 0.2; this.t = this.life;
    this.r = 1.5 + Math.random() * 1.6;
  }
  update(dt) { this.x += this.vx * dt * 60; this.y += this.vy * dt * 60; this.vx *= 0.9; this.vy *= 0.9; this.t -= dt; }
  get dead() { return this.t <= 0; }
  draw(ctx) {
    ctx.globalAlpha = Math.max(0, this.t / this.life);
    ctx.fillStyle = this.color;
    ctx.beginPath(); ctx.arc(this.x, this.y, this.r, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
  }
}
