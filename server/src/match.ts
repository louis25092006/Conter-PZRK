import { World } from '@conter/shared/sim/world.ts'
import { Ship } from '@conter/shared/sim/ship.ts'
import { populateArena } from '@conter/shared/sim/spawner.ts'
import { ARENA_SIZE } from '@conter/shared/sim/arena.ts'
import { SIM_DT, SKIP, type Command } from '@conter/shared/sim/ship-physics.ts'
import { createRng } from '@conter/shared/sim/random.ts'
import { NetworkInput, type PlayerInput } from './player-input.ts'
import { Bot } from './bot.ts'
import { snapshotEntities, collectEvents } from '@conter/shared/net/snapshot.ts'
import { toSeq, toTick, type EntityId, type Seq, type Tick } from '@conter/shared/types.ts'
import type { ArenaConfig } from '@conter/shared/arena-config.ts'
import type { EntityData, InputMsg } from '@conter/shared/protocol.ts'
import type { GameEvent } from '@conter/shared/events.ts'

// Матч кімнати: АВТОРИТЕТНА симуляція на сервері (Lab 5).
//  - клієнти надсилають лише команди { seq, turn, thrust, fire } — ніколи позиції;
//  - сервер 30 разів на секунду: застосовує команди → world.step → розсилає знімок;
//  - один крок симуляції = 1/60 с = одна команда, тож за тік — 2 кроки.

export const TICK_RATE = 30
const STEPS_PER_TICK = 2 // 2 × 1/60 = 1/30

// Lab 7: хто керує літаком — PlayerInput (людина з мережі або бот), матчу байдуже
interface PlayerSlot {
  readonly shipId: EntityId
  readonly input: PlayerInput
  applied: number
}

// Lab 7: останні 300 тривалостей тіку (10 с) — для p50/p95/p99. Кільцевий буфер:
// Float64Array фіксованого розміру, тож запис щотіку нічого не алокує.
const TICK_SAMPLES = 300
function percentile(sorted: Float64Array, p: number): number {
  return sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0) : 0
}

export interface TickData {
  readonly tick: Tick
  readonly entities: readonly EntityData[]
  readonly events: readonly GameEvent[]
}

export class Match {
  #timer: ReturnType<typeof setTimeout> | null = null
  #next = 0
  #lastTickAt = 0
  #tick = 0

  readonly tickRate: number
  readonly world: World
  readonly events: { drain(): GameEvent[] }
  onSnapshot: ((data: TickData) => void) | null
  readonly players = new Map<string, PlayerSlot>()
  readonly #tickSamples = new Float64Array(TICK_SAMPLES)
  #tickSampleCount = 0
  readonly stats = {
    ticks: 0,
    tickMs: 0,
    tickMsMax: 0,
    intervalMs: 0,
    jitterMs: 0,
    droppedInputs: 0,
    starvedSteps: 0,
    catchUpSteps: 0,
  }

  constructor({
    arena,
    onSnapshot = null,
    tickRate = TICK_RATE,
  }: {
    arena: ArenaConfig
    onSnapshot?: ((data: TickData) => void) | null
    tickRate?: number
  }) {
    this.tickRate = tickRate
    this.world = new World({ ...ARENA_SIZE, arena })
    populateArena(this.world)
    this.events = collectEvents(this.world)
    this.onSnapshot = onSnapshot
  }

  get tick(): Tick {
    return toTick(this.#tick)
  }

  #spawnShip(): Ship {
    const spot = this.world.findSafeSpot()
    const ship = this.world.spawn(
      new Ship({ team: 'player', controller: 'input', x: spot.x, y: spot.y, angle: -Math.PI / 2 }),
    )
    ship.invulnerable = 2
    return ship
  }

  addPlayer(playerId: string): EntityId {
    const ship = this.#spawnShip()
    this.players.set(playerId, { shipId: ship.id, input: new NetworkInput(this.stats), applied: 0 })
    return ship.id
  }

  // Lab 7: бот — той самий літак гравця, лише команди дає Bot, а не мережа
  addBot(botId: string): EntityId {
    const ship = this.#spawnShip()
    const bot = new Bot(this.world, ship.id, createRng(ship.id * 7919 + this.players.size))
    this.players.set(botId, { shipId: ship.id, input: bot, applied: 0 })
    return ship.id
  }

  get botCount(): number {
    let n = 0
    for (const p of this.players.values()) if (p.input.kind === 'bot') n++
    return n
  }

  removePlayer(playerId: string): void {
    const p = this.players.get(playerId)
    if (!p) return
    this.world.get(p.shipId)?.kill()
    this.players.delete(playerId)
  }

  // команда вже перевірена protocol.ts/codec; тут — лише порядок і ліміт черги
  pushInput(playerId: string, cmd: InputMsg): boolean {
    const input = this.players.get(playerId)?.input
    // instanceof звужує тип: команди з мережі приймає лише людина, бот їх не отримує
    return input instanceof NetworkInput ? input.push(cmd) : false
  }

  ackFor(playerId: string): Seq {
    const p = this.players.get(playerId)
    const ship = p ? this.world.get(p.shipId) : undefined
    return ship?.kind === 'ship' && ship.lastSeq !== null ? ship.lastSeq : toSeq(0)
  }

  // скільки команд гравця справді застосовано (для тесту на спідхак)
  appliedFor(playerId: string): number {
    return this.players.get(playerId)?.applied ?? 0
  }

  shipOf(playerId: string): EntityId | null {
    return this.players.get(playerId)?.shipId ?? null
  }

  step(): void {
    const t0 = performance.now()
    for (let i = 0; i < STEPS_PER_TICK; i++) {
      const inputs = new Map<EntityId, Command | readonly Command[]>()
      for (const p of this.players.values()) {
        // Одна команда = один крок; не дійшла — літак чекає (SKIP). Деталі — у NetworkInput.
        const cmds = p.input.take()
        p.applied += cmds.length
        inputs.set(p.shipId, cmds.length ? cmds : SKIP)
      }
      this.world.step(SIM_DT, inputs)
    }
    this.#tick++
    this.onSnapshot?.({
      tick: this.tick,
      entities: snapshotEntities(this.world),
      events: this.events.drain(),
    })

    // статистика тіку: скільки тривав і наскільки рівно приходив
    const took = performance.now() - t0
    const s = this.stats
    s.ticks++
    s.tickMs = s.tickMs * 0.95 + took * 0.05
    s.tickMsMax = Math.max(s.tickMsMax * 0.999, took)
    this.#tickSamples[this.#tickSampleCount % TICK_SAMPLES] = took
    this.#tickSampleCount++
    if (this.#lastTickAt) {
      const interval = t0 - this.#lastTickAt
      s.intervalMs = s.intervalMs ? s.intervalMs * 0.95 + interval * 0.05 : interval
      s.jitterMs = s.jitterMs * 0.95 + Math.abs(interval - 1000 / this.tickRate) * 0.05
    }
    this.#lastTickAt = t0
  }

  // Точний таймер: наступний тік плануємо до АБСОЛЮТНОГО часу (next += 1000/30), а не setInterval.
  start(): void {
    if (this.#timer) return
    const period = 1000 / this.tickRate
    this.#next = performance.now() + period
    const loop = (): void => {
      this.step()
      this.#next += period
      const now = performance.now()
      if (this.#next < now - period * 5) this.#next = now + period // сильно відстали — не наздоганяємо
      this.#timer = setTimeout(loop, Math.max(0, this.#next - now))
    }
    this.#timer = setTimeout(loop, period)
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  get running(): boolean {
    return this.#timer !== null
  }

  // перцентилі тривалості тіку за останні ≤ 10 с
  tickPercentiles(): { p50: number; p95: number; p99: number; samples: number } {
    const n = Math.min(this.#tickSampleCount, TICK_SAMPLES)
    const sorted = this.#tickSamples.slice(0, n).sort()
    const r = (x: number): number => Math.round(x * 1000) / 1000
    return {
      p50: r(percentile(sorted, 0.5)),
      p95: r(percentile(sorted, 0.95)),
      p99: r(percentile(sorted, 0.99)),
      samples: n,
    }
  }

  summary() {
    const r = (n: number): number => Math.round(n * 100) / 100
    return {
      tickRate: this.tickRate,
      tick: this.#tick,
      players: this.players.size,
      bots: this.botCount,
      entities: this.world.size,
      tickMs: r(this.stats.tickMs),
      tickMsMax: r(this.stats.tickMsMax),
      tickPercentiles: this.tickPercentiles(),
      intervalMs: r(this.stats.intervalMs),
      jitterMs: r(this.stats.jitterMs),
      droppedInputs: this.stats.droppedInputs,
      starvedSteps: this.stats.starvedSteps,
      catchUpSteps: this.stats.catchUpSteps,
    }
  }
}
