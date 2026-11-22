import {
  stepShip,
  muzzle,
  PLAYER_SHIP,
  SIM_DT,
  type MotionState,
} from '../../../shared/src/sim/ship-physics.ts'
import { ARENA_SIZE } from '../../../shared/src/sim/arena.ts'
import { Asteroid, RADIUS } from '../../../shared/src/sim/asteroid.ts'
import { Explosion } from '../../../shared/src/sim/explosion.ts'
import { Vector2 } from '../../../shared/src/sim/vector.ts'
import { createRng } from '../../../shared/src/sim/random.ts'
import { codecs, byteSize, type Codec } from '../../../shared/src/codec/index.ts'
import { Bus } from '../../../shared/src/bus.ts'
import {
  toSeq,
  assertNever,
  EFFECT_NAMES,
  type EffectName,
  type EntityId,
  type Seq,
} from '../../../shared/src/types.ts'
import type { EntityData, NetsimConfig, ShipData, Snapshot } from '../../../shared/src/protocol.ts'
import type { GameEvent, GameEvents } from '../../../shared/src/events.ts'
import type { ArenaConfig } from '../../../shared/src/arena-config.ts'
import { Connection, socketUrl } from './connection.ts'
import { botCommand, type PlayerCommand } from '../game/commands.ts'
import type { AsteroidView, BulletView, PickupView, Scene, ShipView } from '../render/draw.ts'
import type { HudPlayer, HudWorld } from '../hud.ts'

// Онлайн-гра (Lab 5), Lab 6 — під strict. Сервер — єдина правда; клієнт:
//   1) ПЕРЕДБАЧАЄ свій літак тією ж stepShip, що й сервер;
//   2) ЗВІРЯЄТЬСЯ: стан сервера + повтор непідтверджених команд (seq > ack);
//   3) ЗГЛАДЖУЄ різницю ~100 мс; 4) ІНТЕРПОЛЮЄ чужих у минулому (interpMs);
//   5) ПЕРЕДБАЧАЄ власні кулі, сервер підтверджує їх за spawnSeq.

const { width: W, height: H } = ARENA_SIZE
const SMOOTH_MS = 100
const SNAP_LIMIT = 80 // поправка більша за це — телепорт (респаун), не згладжуємо
const HISTORY = 180 // точок у графіках нетграфа (~6 с при 30 знімках/с)

export interface NetOptions {
  codec?: Codec['name']
  predict?: boolean
  interpMs?: number
  lag?: number
  jitter?: number
  drop?: number
  url?: string // щоб той самий клієнт можна було запустити в Node (net-harness)
}

export interface NetStats {
  rtt: number
  snapshotAge: number
  snapshotInterval: number
  bytesInPerSec: number
  bytesOutPerSec: number
  lastSnapshotBytes: number
  pending: number
  correction: number
  correctionMax: number
  readonly corrections: number[]
  readonly rtts: number[]
  starved: number
}

interface Pending {
  readonly seq: Seq
  readonly cmd: PlayerCommand
}
interface PredictedBullet {
  readonly spawnSeq: Seq
  x: number
  y: number
  readonly vx: number
  readonly vy: number
  ttl: number
  seen: boolean
}
interface StoredSnapshot {
  readonly tick: number
  readonly map: ReadonlyMap<EntityId, EntityData>
}
export interface NetRoom {
  readonly id: string
  readonly name: string
  readonly arenaConfig: Pick<ArenaConfig, 'name'>
}

const EXPLOSION_COLORS = { player: '#ffb347', enemy: '#ff5c5c', neutral: '#ffb347', asteroid: '#c9b79c' }

function wrapDelta(a: number, b: number, size: number): number {
  let d = a - b
  if (d > size / 2) d -= size
  if (d < -size / 2) d += size
  return d
}
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}
function effectsMap(e: ShipData['effects']): Map<EffectName, number> {
  const m = new Map<EffectName, number>()
  for (const name of EFFECT_NAMES) if (e[name] > 0) m.set(name, e[name])
  return m
}

// те саме, що Scene, але з масивами, куди можна додавати
interface SceneItems {
  ship: ShipView[]
  bullet: BulletView[]
  asteroid: AsteroidView[]
  pickup: PickupView[]
  explosion: Explosion[]
}

export class NetGame {
  readonly online = true
  readonly events = new Bus<GameEvents>()
  readonly room: NetRoom
  readonly name: string
  readonly bot: boolean
  readonly opts: { codec: Codec['name']; predict: boolean; interpMs: number }
  readonly codec: Codec
  readonly conn: Connection
  readonly stats: NetStats = {
    rtt: 0,
    snapshotAge: 0,
    snapshotInterval: 0,
    bytesInPerSec: 0,
    bytesOutPerSec: 0,
    lastSnapshotBytes: 0,
    pending: 0,
    correction: 0,
    correctionMax: 0,
    corrections: [],
    rtts: [],
    starved: 0,
  }
  netConfig: NetsimConfig | null = null
  tickMs = 1000 / 30

  you: EntityId | null = null
  ack: Seq = toSeq(0)
  seq = 0
  pending: Pending[] = [] // надіслані, але ще не підтверджені сервером
  predicted: MotionState | null = null
  prevPredicted: MotionState | null = null
  offset = { x: 0, y: 0 } // візуальне згладжування поправки
  myData: ShipData | null = null // останні дані сервера про мій літак
  snapshots: StoredSnapshot[] = []
  clockOffset: number | null = null // performance.now() - tick*tickMs (згладжено)
  predictedBullets: PredictedBullet[] = []
  fx: Explosion[] = [] // локальні вибухи (частинки) за подіями
  readonly fxRng = createRng(7)
  readonly asteroidCache = new Map<EntityId, Asteroid>()
  names = new Map<EntityId, string>() // shipId -> ім'я (з roster)
  lastSnapshotAt = 0
  readonly bytesWindow = { at: performance.now(), inn: 0, out: 0 }
  readonly #pingTimer: ReturnType<typeof setInterval>

  constructor({
    room,
    name,
    net = {},
    bot = false,
  }: {
    room: NetRoom
    name: string
    net?: NetOptions
    bot?: boolean
  }) {
    this.room = room
    this.name = name
    this.bot = bot
    this.opts = {
      codec: net.codec ?? 'binary',
      predict: net.predict !== false,
      interpMs: net.interpMs ?? 100,
    }
    this.codec = codecs[this.opts.codec]

    const q = new URLSearchParams({
      codec: this.opts.codec,
      lag: String(net.lag ?? 0),
      jitter: String(net.jitter ?? 0),
      drop: String(net.drop ?? 0),
    })
    this.conn = new Connection(net.url ? `${net.url}?${q}` : socketUrl(`/ws?${q}`), {
      onOpen: (c) => {
        this.#resetPrediction()
        c.send({ type: 'join', v: 1, roomId: room.id, name })
      },
    })
    const e = this.conn.events
    e.on('welcome', (m) => {
      this.you = m.you.shipId
      this.tickMs = 1000 / m.tickRate
      this.netConfig = m.net
    })
    e.on('roster', (m) => (this.names = new Map(m.players.map((p) => [p.shipId, p.name]))))
    e.on('netsim', (m) => (this.netConfig = { lag: m.lag, jitter: m.jitter, drop: m.drop }))
    e.on('pong', (m) => {
      this.stats.rtt = performance.now() - m.t
      this.#push(this.stats.rtts, this.stats.rtt)
    })
    e.on('binary', (buf) => {
      const snap = this.codec.decodeSnapshot(buf)
      if (snap.ok) this.#onSnapshot(snap.value, buf.byteLength)
      else console.warn('[net] bad snapshot:', snap.error)
    })
    e.on('snapshot', (snap) => this.#onSnapshot(snap, 0))
    this.conn.connect()
    this.#pingTimer = setInterval(() => this.conn.send({ type: 'ping', t: performance.now() }), 500)
  }

  #resetPrediction(): void {
    this.pending = []
    this.predicted = null
    this.predictedBullets = []
    this.snapshots = []
    this.clockOffset = null
    this.seq = 0
  }

  #push(arr: number[], v: number): void {
    arr.push(v)
    if (arr.length > HISTORY) arr.shift()
  }

  setNetSim(cfg: NetsimConfig): void {
    this.conn.send({ type: 'netsim', ...cfg })
  }

  #params() {
    return { ...PLAYER_SHIP, rapid: (this.myData?.effects.rapid ?? 0) > 0 }
  }

  // ---------- 1 крок симуляції (60/с): команда → сервер + передбачення ----------
  step(input: PlayerCommand): void {
    this.#updateBytes()
    if (this.you === null || !this.conn.isOpen) return
    const cmd = this.bot ? botCommand(this.predicted ?? this.myData, this.#botTargets(), this.seq) : input

    const seq = toSeq(++this.seq)
    this.pending.push({ seq, cmd })
    if (this.pending.length > 240) this.pending.shift() // 4 с без підтверджень — щось зовсім не так
    this.conn.sendRaw(this.codec.encodeInput({ type: 'input', seq, ...cmd }))

    const waiting = (this.myData?.respawnIn ?? 0) > 0
    if (this.opts.predict && this.predicted && !waiting) {
      this.prevPredicted = { ...this.predicted }
      const { fired, wrapped } = stepShip(this.predicted, cmd, this.#params(), SIM_DT, W, H)
      if (wrapped) this.prevPredicted = { ...this.predicted }
      if (fired) {
        const m = muzzle(this.predicted, PLAYER_SHIP.radius)
        // постріл видно й чути одразу, не чекаючи сервера
        this.events.emit('fired', {
          type: 'fired',
          team: 'player',
          shipId: this.you,
          homing: false,
          x: m.x,
          y: m.y,
        })
        // самонавідні кулі не передбачаємо: їхню траєкторію знає лише сервер
        if (!((this.myData?.effects.homing ?? 0) > 0))
          this.predictedBullets.push({ spawnSeq: seq, ...m, ttl: 1.2, seen: false })
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

  #botTargets(): EntityData[] {
    const last = this.snapshots.at(-1)
    if (!last) return []
    return [...last.map.values()].filter(
      (e) => (e.kind === 'ship' && e.team === 'enemy') || e.kind === 'asteroid',
    )
  }

  // ---------- знімок від сервера: звірка ----------
  #onSnapshot(snap: Snapshot, bytes: number): void {
    const now = performance.now()
    if (this.lastSnapshotAt)
      this.stats.snapshotInterval = this.stats.snapshotInterval * 0.9 + (now - this.lastSnapshotAt) * 0.1
    this.lastSnapshotAt = now
    this.stats.lastSnapshotBytes = bytes || byteSize(JSON.stringify(snap))

    // годинник сервера: tick * tickMs ≈ now - clockOffset (згладжуємо, бо приходи "тремтять")
    const offset = now - snap.tick * this.tickMs
    this.clockOffset = this.clockOffset === null ? offset : this.clockOffset * 0.9 + offset * 0.1
    if (Math.abs(offset - this.clockOffset) > 500) this.clockOffset = offset

    const map = new Map<EntityId, EntityData>(snap.entities.map((e) => [e.id, e]))
    this.snapshots.push({ tick: snap.tick, map })
    while (this.snapshots.length > 60) this.snapshots.shift()
    if (snap.you !== null) this.you = snap.you
    this.ack = snap.ack

    const my = this.you !== null ? map.get(this.you) : undefined
    if (my?.kind === 'ship') {
      this.myData = my
      this.pending = this.pending.filter((p) => p.seq > snap.ack)
      this.stats.pending = this.pending.length
      if (this.opts.predict) this.#reconcile(my)
    }
    this.#reconcileBullets(map)
    for (const ev of snap.events) this.#onEvent(ev)
  }

  #reconcile(my: ShipData): void {
    const server: MotionState = {
      x: my.x,
      y: my.y,
      vx: my.vx,
      vy: my.vy,
      angle: my.angle,
      cooldown: my.cooldown,
    }
    if (!this.predicted || my.respawnIn > 0) {
      this.predicted = server
      this.prevPredicted = { ...server }
      this.offset = { x: 0, y: 0 }
      return
    }
    const shownX = this.predicted.x + this.offset.x
    const shownY = this.predicted.y + this.offset.y

    // стан сервера + повтор непідтверджених команд = де сервер скаже, що ми будемо
    const state: MotionState = { ...server }
    for (const p of this.pending) stepShip(state, p.cmd, this.#params(), SIM_DT, W, H)

    const correction = Math.hypot(
      wrapDelta(this.predicted.x, state.x, W),
      wrapDelta(this.predicted.y, state.y, H),
    )
    this.stats.correction = correction
    this.#push(this.stats.corrections, correction)
    this.stats.correctionMax = Math.max(...this.stats.corrections.slice(-60))

    this.predicted = state
    this.prevPredicted = { ...state }
    this.offset =
      correction > SNAP_LIMIT
        ? { x: 0, y: 0 }
        : { x: wrapDelta(shownX, state.x, W), y: wrapDelta(shownY, state.y, H) }
  }

  #reconcileBullets(map: ReadonlyMap<EntityId, EntityData>): void {
    const mine = new Set<number>()
    for (const e of map.values())
      if (e.kind === 'bullet' && e.ownerId === this.you && e.spawnSeq !== null) mine.add(e.spawnSeq)
    this.predictedBullets = this.predictedBullets.filter((b) => {
      if (mine.has(b.spawnSeq)) {
        b.seen = true
        return true
      }
      if (b.seen) return false // була на сервері, тепер немає — влучила або згасла
      return this.ack < b.spawnSeq + 6 // сервер уже обробив ту команду, а кулі нема — не стріляв
    })
  }

  #onEvent(ev: GameEvent): void {
    // switch за type з never: нова подія в протоколі без обробки тут — помилка компіляції
    switch (ev.type) {
      case 'fired':
        if (ev.shipId === this.you && this.opts.predict) return // уже зіграли при передбаченні
        return this.events.emit('fired', ev)
      case 'hit':
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
        return this.events.emit('hit', ev)
      case 'exploded': {
        const big = ev.kind === 'ship'
        const color = big ? EXPLOSION_COLORS[ev.team] : EXPLOSION_COLORS.asteroid
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
        return this.events.emit('exploded', ev)
      }
      case 'pickup':
        if (ev.shipId === this.you) this.events.emit('pickup', ev) // чужі бонуси — не наша справа
        return
      case 'score':
        if (ev.shipId === this.you) this.events.emit('score', ev)
        return
      default:
        return assertNever(ev, 'game event')
    }
  }

  #updateBytes(): void {
    const w = this.bytesWindow
    const now = performance.now()
    if (now - w.at >= 1000) {
      this.stats.bytesInPerSec = ((this.conn.bytesIn - w.inn) * 1000) / (now - w.at)
      this.stats.bytesOutPerSec = ((this.conn.bytesOut - w.out) * 1000) / (now - w.at)
      w.at = now
      w.inn = this.conn.bytesIn
      w.out = this.conn.bytesOut
    }
    this.stats.snapshotAge = this.lastSnapshotAt ? now - this.lastSnapshotAt : 0
  }

  // ---------- що малювати ----------
  view(alpha: number, now = performance.now()): Scene {
    const items: SceneItems = { ship: [], bullet: [], asteroid: [], pickup: [], explosion: this.fx }
    const first = this.snapshots[0]
    const last = this.snapshots.at(-1)
    if (!first || !last || this.clockOffset === null) return items

    // час рендеру = поточний тік сервера мінус затримка інтерполяції
    const renderTick = (now - this.clockOffset - this.opts.interpMs) / this.tickMs
    let a: StoredSnapshot = first
    let b: StoredSnapshot = last
    if (renderTick >= last.tick) {
      a = last // знімків "з майбутнього" немає — стоїмо на останньому
      this.stats.starved++
    } else {
      for (let i = this.snapshots.length - 1; i > 0; i--) {
        const prev = this.snapshots[i - 1]
        const cur = this.snapshots[i]
        if (prev && cur && prev.tick <= renderTick) {
          a = prev
          b = cur
          break
        }
      }
    }
    const t = b.tick === a.tick ? 1 : Math.min(1, Math.max(0, (renderTick - a.tick) / (b.tick - a.tick)))

    for (const eb of b.map.values()) {
      const mine = eb.id === this.you
      if (mine && this.opts.predict) continue // свій літак — з передбачення
      if (
        eb.kind === 'bullet' &&
        eb.ownerId === this.you &&
        this.opts.predict &&
        this.#hasPredicted(eb.spawnSeq)
      )
        continue
      const ea = a.map.get(eb.id) ?? eb // з'явилась між знімками — малюємо там, де є
      // без передбачення ("тупий клієнт") свій літак — просто з останнього знімка
      const src = mine ? (last.map.get(eb.id) ?? eb) : eb
      const far = Math.abs(eb.x - ea.x) > W / 2 || Math.abs(eb.y - ea.y) > H / 2 // перелетів через край
      const x = mine || far ? src.x : ea.x + (eb.x - ea.x) * t
      const y = mine || far ? src.y : ea.y + (eb.y - ea.y) * t
      const angle = mine ? src.angle : lerpAngle(ea.angle, eb.angle, t)
      this.#addView(items, src, x, y, angle)
    }

    // свій літак: передбачення (між двома кроками — alpha) + залишок згладжування
    if (this.opts.predict && this.predicted && this.myData) {
      const cur = this.predicted
      const p = this.prevPredicted ?? cur
      const far = Math.abs(cur.x - p.x) > W / 2 || Math.abs(cur.y - p.y) > H / 2
      const x = (far ? cur.x : p.x + (cur.x - p.x) * alpha) + this.offset.x
      const y = (far ? cur.y : p.y + (cur.y - p.y) * alpha) + this.offset.y
      this.#addView(items, this.myData, (x + W) % W, (y + H) % H, lerpAngle(p.angle, cur.angle, alpha))
    }
    for (const pb of this.predictedBullets) {
      const pos = { x: pb.x, y: pb.y }
      items.bullet.push({
        team: 'player',
        homing: false,
        radius: 3,
        pos,
        prevPos: pos,
        vel: new Vector2(pb.vx, pb.vy),
        angle: 0,
        prevAngle: 0,
      })
    }
    return items
  }

  #hasPredicted(seq: Seq | null): boolean {
    return seq !== null && this.predictedBullets.some((b) => b.spawnSeq === seq)
  }

  #addView(items: SceneItems, e: EntityData, x: number, y: number, angle: number): void {
    const pos = { x, y }
    const placed = { pos, prevPos: pos, angle, prevAngle: angle }
    switch (e.kind) {
      case 'ship':
        items.ship.push({
          ...placed,
          id: e.id,
          team: e.team,
          radius: PLAYER_SHIP.radius,
          thrust: e.thrust,
          isWaitingRespawn: e.respawnIn > 0,
          invulnerable: e.invulnerable,
          effects: effectsMap(e.effects),
          hp: e.hp,
          maxHp: e.maxHp,
          name: this.names.get(e.id),
          isMe: e.id === this.you,
        })
        return
      case 'bullet':
        items.bullet.push({
          ...placed,
          team: e.team,
          homing: e.homing,
          radius: 3,
          vel: Vector2.fromAngle(angle),
        })
        return
      case 'asteroid': {
        // Asteroid з тим самим id — щоб запасне векторне малювання мало форму й кратери
        let rock = this.asteroidCache.get(e.id)
        if (!rock) {
          rock = new Asteroid({ size: e.size, rng: createRng(e.id) })
          this.asteroidCache.set(e.id, rock)
          const oldest = this.asteroidCache.keys().next()
          if (this.asteroidCache.size > 200 && !oldest.done) this.asteroidCache.delete(oldest.value)
        }
        rock.variant = e.variant
        rock.radius = RADIUS[e.size]
        rock.pos = new Vector2(x, y)
        rock.prevPos = rock.pos
        rock.angle = angle
        rock.prevAngle = angle
        items.asteroid.push({
          ...placed,
          radius: rock.radius,
          homing: e.homing,
          variant: e.variant,
          shape: rock.shape,
          craters: rock.craters,
          specks: rock.specks,
        })
        return
      }
      case 'pickup':
        items.pickup.push({ pos, effect: e.effect, ttl: e.ttl, radius: 13 })
        return
      default:
        assertNever(e, 'entity kind')
    }
  }

  // HUD: мій літак і "світ"
  get me(): HudPlayer {
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
      effects: effectsMap(d.effects),
      isWaitingRespawn: d.respawnIn > 0,
      respawnIn: d.respawnIn,
      score: d.score,
      deaths: d.deaths,
    }
  }

  get hudWorld(): HudWorld {
    return { size: this.snapshots.at(-1)?.map.size ?? 0, arena: this.room.arenaConfig }
  }

  close(): void {
    clearInterval(this.#pingTimer)
    this.conn.close(1000, 'left the game')
  }
}
