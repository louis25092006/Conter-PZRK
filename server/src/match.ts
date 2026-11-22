import { World } from '@conter/shared/sim/world.ts'
import { Ship } from '@conter/shared/sim/ship.ts'
import { populateArena } from '@conter/shared/sim/spawner.ts'
import { ARENA_SIZE } from '@conter/shared/sim/arena.ts'
import { SIM_DT, IDLE, SKIP, type Command } from '@conter/shared/sim/ship-physics.ts'
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
const MAX_QUEUE = 30 // ~0.5 с команд наперед; більше — клієнт шле занадто часто (спідхак)
const JITTER_BUFFER = 2 // скільки команд тримаємо в запасі проти джитера
const MAX_CREDIT = 10 // скільки "пропущених" кроків можна наздогнати

interface PlayerSlot {
  shipId: EntityId
  queue: InputMsg[]
  lastQueuedSeq: number
  lastCmd: Command
  credit: number
  applied: number
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

  addPlayer(playerId: string): EntityId {
    const spot = this.world.findSafeSpot()
    const ship = this.world.spawn(
      new Ship({ team: 'player', controller: 'input', x: spot.x, y: spot.y, angle: -Math.PI / 2 }),
    )
    ship.invulnerable = 2
    this.players.set(playerId, {
      shipId: ship.id,
      queue: [],
      lastQueuedSeq: 0,
      lastCmd: IDLE,
      credit: 0,
      applied: 0,
    })
    return ship.id
  }

  removePlayer(playerId: string): void {
    const p = this.players.get(playerId)
    if (!p) return
    this.world.get(p.shipId)?.kill()
    this.players.delete(playerId)
  }

  // команда вже перевірена protocol.ts/codec; тут — лише порядок і ліміт черги
  pushInput(playerId: string, cmd: InputMsg): boolean {
    const p = this.players.get(playerId)
    if (!p) return false
    if (cmd.seq <= p.lastQueuedSeq) return false // дубль або застаріла
    if (p.queue.length >= MAX_QUEUE) {
      this.stats.droppedInputs++
      return false
    }
    p.lastQueuedSeq = cmd.seq
    p.queue.push(cmd)
    return true
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
        // Одна команда = один крок. Не дійшла — літак чекає (SKIP), гравець отримує кредит;
        // коли команди приходять пачкою, зайві застосовуємо одразу, витрачаючи кредит.
        const cmds: Command[] = []
        const first = p.queue.shift()
        if (first) cmds.push(first)
        else {
          p.credit = Math.min(MAX_CREDIT, p.credit + 1)
          this.stats.starvedSteps++
        }
        for (
          let extra = p.queue[0];
          extra && p.queue.length > JITTER_BUFFER && p.credit > 0;
          extra = p.queue[0]
        ) {
          p.queue.shift()
          cmds.push(extra)
          p.credit--
          this.stats.catchUpSteps++
        }
        const last = cmds.at(-1)
        if (last) p.lastCmd = last
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

  summary() {
    const r = (n: number): number => Math.round(n * 100) / 100
    return {
      tickRate: this.tickRate,
      tick: this.#tick,
      players: this.players.size,
      entities: this.world.size,
      tickMs: r(this.stats.tickMs),
      tickMsMax: r(this.stats.tickMsMax),
      intervalMs: r(this.stats.intervalMs),
      jitterMs: r(this.stats.jitterMs),
      droppedInputs: this.stats.droppedInputs,
      starvedSteps: this.stats.starvedSteps,
      catchUpSteps: this.stats.catchUpSteps,
    }
  }
}
