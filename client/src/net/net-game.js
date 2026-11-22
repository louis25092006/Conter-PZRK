import { stepShip, muzzle, PLAYER_SHIP, SIM_DT } from '../../../shared/src/sim/ship-physics.js'
import { ARENA_SIZE } from '../../../shared/src/sim/arena.js'
import { Asteroid, RADIUS } from '../../../shared/src/sim/asteroid.js'
import { Explosion } from '../../../shared/src/sim/explosion.js'
import { Vector2 } from '../../../shared/src/sim/vector.js'
import { createRng } from '../../../shared/src/sim/random.js'
import { codecs, byteSize } from '../../../shared/src/codec/index.js'
import { Connection, socketUrl } from './connection.js'
import { botCommand } from '../game/commands.js'

// Онлайн-гра (Lab 5). Сервер — єдина правда; клієнт:
//   1) ПЕРЕДБАЧАЄ свій літак: застосовує власні команди одразу, тією ж stepShip, що й сервер;
//   2) ЗВІРЯЄТЬСЯ: на кожен знімок бере стан сервера, викидає підтверджені команди (seq ≤ ack)
//      і заново застосовує решту — отримує, де сервер скаже, що літак ПІСЛЯ них;
//   3) ЗГЛАДЖУЄ різницю, якщо передбачення помилилось (колізія), ~100 мс замість ривка;
//   4) ІНТЕРПОЛЮЄ чужих: малює їх трохи в минулому (interpMs) між двома знімками;
//   5) ПЕРЕДБАЧАЄ власні кулі: показує одразу, сервер підтверджує за spawnSeq.

const { width: W, height: H } = ARENA_SIZE
const SMOOTH_MS = 100
const SNAP_LIMIT = 80 // поправка більша за це — телепорт (респаун), не згладжуємо
const HISTORY = 180 // точок у графіках нетграфа (~6 с при 30 знімках/с)

const EXPLOSION_COLORS = { ship: { player: '#ffb347', enemy: '#ff5c5c' }, asteroid: '#c9b79c' }

function wrapDelta(a, b, size) {
  let d = a - b
  if (d > size / 2) d -= size
  if (d < -size / 2) d += size
  return d
}
function lerpAngle(a, b, t) {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

export class NetGame extends EventTarget {
  constructor({ room, name, net = {}, bot = false }) {
    super()
    this.online = true
    this.room = room
    this.name = name
    this.bot = bot
    this.opts = {
      codec: net.codec === 'json' ? 'json' : 'binary',
      predict: net.predict !== false,
      interpMs: net.interpMs ?? 100,
    }
    this.codec = codecs[this.opts.codec]
    this.tickMs = 1000 / 30

    // стан
    this.you = 0
    this.ack = 0
    this.seq = 0
    this.pending = [] // { seq, cmd } — надіслані, але ще не підтверджені сервером
    this.predicted = null // { x, y, vx, vy, angle, cooldown }
    this.prevPredicted = null
    this.offset = { x: 0, y: 0 } // візуальне згладжування поправки
    this.myData = null // останні дані сервера про мій літак (hp, ефекти, очки…)
    this.snapshots = [] // [{ tick, at, map: Map<id, entity> }]
    this.clockOffset = null // performance.now() - tick*tickMs (згладжено)
    this.predictedBullets = [] // { spawnSeq, x, y, vx, vy, ttl, seen }
    this.fx = [] // локальні вибухи (частинки) за подіями
    this.fxRng = createRng(7)
    this.asteroidCache = new Map() // id -> Asteroid (для запасного векторного малювання)
    this.names = new Map() // shipId -> ім'я (з roster)

    // нетграф
    this.stats = {
      rtt: 0,
      snapshotAge: 0,
      snapshotInterval: 0,
      bytesInPerSec: 0,
      bytesOutPerSec: 0,
      lastSnapshotBytes: 0,
      pending: 0,
      correction: 0,
      correctionMax: 0,
      corrections: [], // історія поправок, px
      rtts: [],
      starved: 0, // скільки кадрів не вистачило знімка для інтерполяції
    }
    this.lastSnapshotAt = 0
    this.bytesWindow = { at: performance.now(), inn: 0, out: 0 }

    const q = new URLSearchParams({
      codec: this.opts.codec,
      lag: String(net.lag ?? 0),
      jitter: String(net.jitter ?? 0),
      drop: String(net.drop ?? 0),
    })
    // net.url — щоб той самий клієнт можна було запустити в Node (вимірювання, тести)
    this.conn = new Connection(net.url ? `${net.url}?${q}` : socketUrl(`/ws?${q}`), {
      onOpen: (c) => {
        this.#resetPrediction()
        c.send({ type: 'join', v: 1, roomId: room.id, name })
      },
    })
    this.conn.addEventListener('welcome', (e) => {
      this.you = e.detail.you.shipId
      this.tickMs = 1000 / (e.detail.tickRate ?? 30)
      this.netConfig = e.detail.net
    })
    this.conn.addEventListener('roster', (e) => {
      this.names = new Map(e.detail.players.map((p) => [p.shipId, p.name]))
    })
    this.conn.addEventListener('netsim', (e) => (this.netConfig = e.detail))
    this.conn.addEventListener('pong', (e) => {
      this.stats.rtt = performance.now() - e.detail.t
      this.#push(this.stats.rtts, this.stats.rtt)
    })
    this.conn.addEventListener('binary', (e) =>
      this.#onSnapshot(this.codec.decodeSnapshot(e.detail), e.detail.byteLength),
    )
    this.conn.addEventListener('snapshot', (e) => this.#onSnapshot(e.detail, 0))
    this.conn.connect()
    this.pingTimer = setInterval(() => this.conn.send({ type: 'ping', t: performance.now() }), 500)
  }

  get events() {
    return this
  }

  #resetPrediction() {
    this.pending = []
    this.predicted = null
    this.predictedBullets = []
    this.snapshots = []
    this.clockOffset = null
    this.seq = 0
  }

  #push(arr, v) {
    arr.push(v)
    if (arr.length > HISTORY) arr.shift()
  }

  // змінити імітацію мережі на сервері "на льоту"
  setNetSim(cfg) {
    this.conn.send({ type: 'netsim', ...cfg })
  }

  // ---------- 1 крок симуляції (60/с): команда → сервер + передбачення ----------
  step(cmd) {
    this.#updateBytes()
    if (!this.you || !this.conn.isOpen) return
    if (this.bot) cmd = botCommand(this.predicted ?? this.myData, this.#botTargets(), this.seq)

    const seq = ++this.seq
    this.pending.push({ seq, cmd })
    if (this.pending.length > 240) this.pending.shift() // 4 с без підтверджень — щось зовсім не так
    this.conn.sendRaw(this.codec.encodeInput({ seq, ...cmd }))

    const waiting = this.myData?.respawnIn > 0
    if (this.opts.predict && this.predicted && !waiting) {
      this.prevPredicted = { ...this.predicted }
      const { fired, wrapped } = stepShip(this.predicted, cmd, this.#params(), SIM_DT, W, H)
      if (wrapped) this.prevPredicted = { ...this.predicted }
      if (fired) {
        // постріл видно й чути одразу, не чекаючи сервера
        this.dispatchEvent(new CustomEvent('fired', { detail: { team: 'player', shipId: this.you } }))
        if (!(this.myData?.effects.homing > 0)) {
          // самонавідні кулі не передбачаємо: їхню траєкторію знає лише сервер
          this.predictedBullets.push({
            spawnSeq: seq,
            ...muzzle(this.predicted, PLAYER_SHIP.radius),
            ttl: 1.2,
            seen: false,
          })
        }
      }
    }

    for (const b of this.predictedBullets) {
      b.x = (b.x + b.vx * SIM_DT + W) % W
      b.y = (b.y + b.vy * SIM_DT + H) % H
      b.ttl -= SIM_DT
    }
    this.predictedBullets = this.predictedBullets.filter((b) => b.ttl > 0)
    for (const f of this.fx) f.update(SIM_DT)
    this.fx = this.fx.filter((f) => f.alive)

    // згладжування: залишок поправки тане експоненційно (~100 мс)
    const k = Math.exp(-(SIM_DT * 1000) / SMOOTH_MS)
    this.offset.x *= k
    this.offset.y *= k
  }

  #params() {
    return { ...PLAYER_SHIP, rapid: (this.myData?.effects.rapid ?? 0) > 0 }
  }

  #botTargets() {
    const last = this.snapshots.at(-1)
    if (!last) return []
    return [...last.map.values()].filter(
      (e) => (e.kind === 'ship' && e.team === 'enemy') || e.kind === 'asteroid',
    )
  }

  // ---------- знімок від сервера: звірка ----------
  #onSnapshot(snap, bytes) {
    const now = performance.now()
    if (this.lastSnapshotAt) {
      const dt = now - this.lastSnapshotAt
      this.stats.snapshotInterval = this.stats.snapshotInterval * 0.9 + dt * 0.1
    }
    this.lastSnapshotAt = now
    this.stats.lastSnapshotBytes = bytes || byteSize(JSON.stringify(snap))

    // годинник сервера: tick * tickMs ≈ now - clockOffset (згладжуємо, бо приходи "тремтять")
    const offset = now - snap.tick * this.tickMs
    this.clockOffset = this.clockOffset === null ? offset : this.clockOffset * 0.9 + offset * 0.1
    if (Math.abs(offset - this.clockOffset) > 500) this.clockOffset = offset // різкий стрибок (лаг змінили)

    const map = new Map(snap.entities.map((e) => [e.id, e]))
    this.snapshots.push({ tick: snap.tick, map })
    while (this.snapshots.length > 60) this.snapshots.shift()
    this.you = snap.you || this.you
    this.ack = snap.ack

    const my = map.get(this.you)
    if (my) {
      this.myData = my
      this.pending = this.pending.filter((p) => p.seq > snap.ack)
      this.stats.pending = this.pending.length
      if (this.opts.predict) this.#reconcile(my)
    }
    this.#reconcileBullets(map)

    for (const ev of snap.events) this.#onEvent(ev)
  }

  #reconcile(my) {
    const server = { x: my.x, y: my.y, vx: my.vx, vy: my.vy, angle: my.angle, cooldown: my.cooldown }
    if (!this.predicted || my.respawnIn > 0) {
      this.predicted = server
      this.prevPredicted = { ...server }
      this.offset = { x: 0, y: 0 }
      return
    }
    // де літак на екрані ЗАРАЗ (передбачення + залишок згладжування)
    const shownX = this.predicted.x + this.offset.x
    const shownY = this.predicted.y + this.offset.y

    // стан сервера + повтор непідтверджених команд = де сервер скаже, що ми будемо
    const state = { ...server }
    for (const p of this.pending) stepShip(state, p.cmd, this.#params(), SIM_DT, W, H)

    const dx = wrapDelta(this.predicted.x, state.x, W)
    const dy = wrapDelta(this.predicted.y, state.y, H)
    const correction = Math.hypot(dx, dy)
    this.stats.correction = correction
    this.#push(this.stats.corrections, correction)
    this.stats.correctionMax = Math.max(...this.stats.corrections.slice(-60))

    this.predicted = state
    this.prevPredicted = { ...state }
    if (correction > SNAP_LIMIT) {
      this.offset = { x: 0, y: 0 } // телепорт/респаун — не "пливемо" через пів екрана
    } else {
      // візуально лишаємося, де були, і плавно під'їжджаємо (offset тане в step)
      this.offset = { x: wrapDelta(shownX, state.x, W), y: wrapDelta(shownY, state.y, H) }
    }
  }

  // передбачені кулі: сервер підтвердив (бачимо кулю з тим самим spawnSeq) → чекаємо;
  // сервер її прибрав (влучила) → прибираємо й ми; сервер так і не випустив → прибираємо
  #reconcileBullets(map) {
    const mine = new Set()
    for (const e of map.values()) if (e.kind === 'bullet' && e.ownerId === this.you) mine.add(e.spawnSeq)
    this.predictedBullets = this.predictedBullets.filter((b) => {
      if (mine.has(b.spawnSeq)) {
        b.seen = true
        return true
      }
      if (b.seen) return false // була на сервері, тепер немає — влучила або згасла
      return this.ack < b.spawnSeq + 6 // сервер уже обробив ту команду, а кулі нема — не стріляв
    })
    this.serverBulletSeqs = mine
  }

  #onEvent(ev) {
    const mine = ev.shipId === this.you
    if (ev.type === 'fired' && mine && this.opts.predict) return // уже зіграли при передбаченні
    if ((ev.type === 'score' || ev.type === 'pickup') && !mine) return // чужі очки/бонуси — не наша справа
    if (ev.type === 'exploded') {
      const color =
        ev.kind === 'ship' ? (EXPLOSION_COLORS.ship[ev.team] ?? '#ffb347') : EXPLOSION_COLORS.asteroid
      const big = ev.kind === 'ship'
      this.fx.push(
        new Explosion({
          rng: this.fxRng,
          x: ev.x,
          y: ev.y,
          count: big ? 40 : 10 + ev.size * 8,
          speed: big ? 220 : 120,
          color,
        }),
      )
    } else if (ev.type === 'hit') {
      this.fx.push(
        new Explosion({
          rng: this.fxRng,
          x: ev.x,
          y: ev.y,
          count: 6,
          speed: 90,
          ttl: 0.35,
          color: ev.target === 'ship' ? '#ffe066' : '#aaa',
        }),
      )
    }
    this.dispatchEvent(new CustomEvent(ev.type, { detail: ev }))
  }

  #updateBytes() {
    const w = this.bytesWindow
    const now = performance.now()
    if (now - w.at >= 1000) {
      this.stats.bytesInPerSec = ((this.conn.bytesIn - w.inn) * 1000) / (now - w.at)
      this.stats.bytesOutPerSec = ((this.conn.bytesOut - w.out) * 1000) / (now - w.at)
      Object.assign(w, { at: now, inn: this.conn.bytesIn, out: this.conn.bytesOut })
    }
    this.stats.snapshotAge = this.lastSnapshotAt ? now - this.lastSnapshotAt : 0
  }

  // ---------- що малювати ----------
  // Повертає об'єкт з ofKind(kind), як у World, — щоб draw.js малював однаково офлайн і онлайн.
  view(alpha, now = performance.now()) {
    const items = { ship: [], bullet: [], asteroid: [], pickup: [], explosion: this.fx }
    const snaps = this.snapshots
    if (snaps.length === 0) return makeScene(items)

    // час рендеру = поточний тік сервера мінус затримка інтерполяції
    const renderTick = (now - this.clockOffset - this.opts.interpMs) / this.tickMs
    let a = snaps[0]
    let b = snaps[snaps.length - 1]
    if (renderTick >= b.tick) {
      a = b // знімків "з майбутнього" немає — стоїмо на останньому (затримка замала або лаг)
      this.stats.starved++
    } else {
      for (let i = snaps.length - 1; i > 0; i--) {
        if (snaps[i - 1].tick <= renderTick) {
          a = snaps[i - 1]
          b = snaps[i]
          break
        }
      }
    }
    const t = b.tick === a.tick ? 1 : Math.min(1, Math.max(0, (renderTick - a.tick) / (b.tick - a.tick)))
    const latest = snaps[snaps.length - 1]

    for (const eb of b.map.values()) {
      if (eb.id === this.you && this.opts.predict) continue // свій літак — з передбачення
      if (
        eb.kind === 'bullet' &&
        eb.ownerId === this.you &&
        this.opts.predict &&
        this.#hasPredicted(eb.spawnSeq)
      )
        continue
      const ea = a.map.get(eb.id) ?? eb // з'явилась між знімками — малюємо там, де є
      let src = eb
      // без передбачення ("тупий клієнт") свій літак — просто з останнього знімка
      if (eb.id === this.you) src = latest.map.get(eb.id) ?? eb
      const far = Math.abs(eb.x - ea.x) > W / 2 || Math.abs(eb.y - ea.y) > H / 2 // перелетів через край
      const x = eb.id === this.you || far ? src.x : ea.x + (eb.x - ea.x) * t
      const y = eb.id === this.you || far ? src.y : ea.y + (eb.y - ea.y) * t
      const angle = eb.id === this.you ? src.angle : lerpAngle(ea.angle, eb.angle, t)
      const v = this.#viewOf(src, x, y, angle)
      if (v) items[eb.kind].push(v)
    }

    // свій літак: передбачення (між двома кроками — alpha) + залишок згладжування
    if (this.opts.predict && this.predicted && this.myData) {
      const p = this.prevPredicted ?? this.predicted
      const far = Math.abs(this.predicted.x - p.x) > W / 2 || Math.abs(this.predicted.y - p.y) > H / 2
      const x = (far ? this.predicted.x : p.x + (this.predicted.x - p.x) * alpha) + this.offset.x
      const y = (far ? this.predicted.y : p.y + (this.predicted.y - p.y) * alpha) + this.offset.y
      const angle = lerpAngle(p.angle, this.predicted.angle, alpha)
      const v = this.#viewOf({ ...this.myData, thrust: this.myData.thrust }, (x + W) % W, (y + H) % H, angle)
      items.ship.push(v)
    }
    for (const pb of this.predictedBullets) {
      items.bullet.push({
        kind: 'bullet',
        team: 'player',
        homing: false,
        radius: 3,
        pos: { x: pb.x, y: pb.y },
        prevPos: { x: pb.x, y: pb.y },
        vel: new Vector2(pb.vx, pb.vy),
        angle: 0,
        prevAngle: 0,
      })
    }
    return makeScene(items)
  }

  #hasPredicted(seq) {
    return this.predictedBullets.some((b) => b.spawnSeq === seq)
  }

  #viewOf(e, x, y, angle) {
    const base = { id: e.id, kind: e.kind, pos: { x, y }, prevPos: { x, y }, angle, prevAngle: angle }
    switch (e.kind) {
      case 'ship':
        return {
          ...base,
          team: e.team,
          radius: PLAYER_SHIP.radius,
          thrust: e.thrust,
          isWaitingRespawn: e.respawnIn > 0,
          respawnIn: e.respawnIn,
          invulnerable: e.invulnerable,
          effects: new Map(Object.entries(e.effects).filter(([, v]) => v > 0)),
          hp: e.hp,
          maxHp: e.maxHp,
          name: this.names.get(e.id),
          isMe: e.id === this.you,
        }
      case 'bullet':
        return { ...base, team: e.team, homing: e.homing, radius: 3, vel: Vector2.fromAngle(angle) }
      case 'asteroid': {
        // Asteroid з тим самим id — щоб запасне векторне малювання мало форму й кратери
        let a = this.asteroidCache.get(e.id)
        if (!a) {
          a = new Asteroid({ size: e.size, rng: createRng(e.id) })
          this.asteroidCache.set(e.id, a)
          if (this.asteroidCache.size > 200) this.asteroidCache.delete(this.asteroidCache.keys().next().value)
        }
        a.variant = e.variant
        a.homing = e.homing ? {} : null
        a.radius = RADIUS[e.size]
        a.pos = base.pos
        a.prevPos = base.pos
        a.angle = angle
        a.prevAngle = angle
        return a
      }
      case 'pickup':
        return { ...base, effect: e.effect, ttl: e.ttl, radius: 13 }
      default:
        return null
    }
  }

  // HUD: мій літак і "світ"
  get me() {
    const d = this.myData
    if (!d)
      return {
        hp: 0,
        maxHp: PLAYER_SHIP.maxHp,
        effects: new Map(),
        isWaitingRespawn: false,
        respawnIn: 0,
        score: 0,
        deaths: 0,
      }
    return {
      hp: d.hp,
      maxHp: d.maxHp,
      effects: new Map(Object.entries(d.effects).filter(([, v]) => v > 0)),
      isWaitingRespawn: d.respawnIn > 0,
      respawnIn: d.respawnIn,
      score: d.score,
      deaths: d.deaths,
    }
  }

  get hudWorld() {
    return { size: this.snapshots.at(-1)?.map.size ?? 0, arena: this.room.arenaConfig }
  }

  close() {
    clearInterval(this.pingTimer)
    this.conn.close(1000, 'left the game')
  }
}

function makeScene(items) {
  return {
    *ofKind(kind) {
      yield* items[kind] ?? []
    },
    items,
  }
}
