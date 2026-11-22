import { World } from '@conter/shared/sim/world.js'
import { Ship } from '@conter/shared/sim/ship.js'
import { populateArena } from '@conter/shared/sim/spawner.js'
import { ARENA_SIZE } from '@conter/shared/sim/arena.js'
import { SIM_DT, IDLE, SKIP } from '@conter/shared/sim/ship-physics.js'
import { snapshotEntities, collectEvents } from '@conter/shared/net/snapshot.js'

// Матч кімнати: АВТОРИТЕТНА симуляція на сервері.
//  - клієнти надсилають лише команди { seq, turn, thrust, fire } — ніколи позиції;
//  - сервер 30 разів на секунду: застосовує команди → world.step → розсилає знімок;
//  - один крок симуляції = 1/60 с = одна команда, тож за тік — 2 кроки.
// Позиції рахує лише сервер, тому "телепорт" чи "швидкість ×10" з клієнта неможливі.

export const TICK_RATE = 30
const STEPS_PER_TICK = 2 // 2 × 1/60 = 1/30
const MAX_QUEUE = 30 // ~0.5 с команд наперед; більше — клієнт шле занадто часто (спідхак)
const JITTER_BUFFER = 2 // скільки команд тримаємо в запасі проти джитера
const MAX_CREDIT = 10 // скільки "пропущених" кроків можна наздогнати

export class Match {
  #timer = null
  #next = 0
  #lastTickAt = 0

  constructor({ arena, onSnapshot, tickRate = TICK_RATE }) {
    this.tickRate = tickRate
    this.world = new World({ ...ARENA_SIZE, arena })
    populateArena(this.world)
    this.events = collectEvents(this.world)
    this.onSnapshot = onSnapshot
    this.tick = 0
    this.players = new Map() // playerId -> { shipId, queue, lastQueuedSeq, lastCmd }
    this.stats = {
      ticks: 0,
      tickMs: 0,
      tickMsMax: 0,
      intervalMs: 0,
      jitterMs: 0,
      droppedInputs: 0,
      starvedSteps: 0,
      catchUpSteps: 0,
    }
  }

  addPlayer(playerId) {
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

  removePlayer(playerId) {
    const p = this.players.get(playerId)
    if (!p) return
    this.world.get(p.shipId)?.kill()
    this.players.delete(playerId)
  }

  // команда вже перевірена protocol.js; тут — лише порядок і ліміт черги
  pushInput(playerId, cmd) {
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

  ackFor(playerId) {
    const p = this.players.get(playerId)
    return p ? (this.world.get(p.shipId)?.lastSeq ?? 0) : 0
  }

  // скільки команд гравця справді застосовано (для тесту на спідхак)
  appliedFor(playerId) {
    return this.players.get(playerId)?.applied ?? 0
  }

  shipOf(playerId) {
    return this.players.get(playerId)?.shipId ?? 0
  }

  step() {
    const t0 = performance.now()
    for (let i = 0; i < STEPS_PER_TICK; i++) {
      const inputs = new Map()
      for (const p of this.players.values()) {
        // Одна команда = один крок. Не дійшла — літак цей крок чекає (SKIP), а гравець отримує
        // "кредит" на 1 крок. Коли команди приходять пачкою (джитер), зайві застосовуємо одразу,
        // витрачаючи кредит. Разом застосовано ≤ (кроків, що минули) + MAX_CREDIT — тож прискоритись,
        // шлючи команди частіше, неможливо (спідхак), а затримка в мережі не накопичується в черзі.
        const cmds = []
        const first = p.queue.shift()
        if (first) cmds.push(first)
        else {
          p.credit = Math.min(MAX_CREDIT, p.credit + 1)
          this.stats.starvedSteps++
        }
        while (p.queue.length > JITTER_BUFFER && p.credit > 0) {
          cmds.push(p.queue.shift())
          p.credit--
          this.stats.catchUpSteps++
        }
        if (cmds.length) p.lastCmd = cmds.at(-1)
        p.applied += cmds.length
        inputs.set(p.shipId, cmds.length ? cmds : SKIP)
      }
      this.world.step(SIM_DT, inputs)
    }
    this.tick++
    const entities = snapshotEntities(this.world)
    const events = this.events.drain()
    this.onSnapshot?.({ tick: this.tick, entities, events })

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

  // Точний таймер: setInterval(tick, 33) "пливе" (33 ≠ 33.33 і затримки накопичуються).
  // Тому кожен наступний тік плануємо до АБСОЛЮТНОГО часу: next += 1000/30.
  start() {
    if (this.#timer) return
    const period = 1000 / this.tickRate
    this.#next = performance.now() + period
    const loop = () => {
      this.step()
      this.#next += period
      const now = performance.now()
      if (this.#next < now - period * 5) this.#next = now + period // сильно відстали (сервер спав) — не наздоганяємо
      this.#timer = setTimeout(loop, Math.max(0, this.#next - now))
    }
    this.#timer = setTimeout(loop, period)
  }

  stop() {
    clearTimeout(this.#timer)
    this.#timer = null
  }

  get running() {
    return this.#timer !== null
  }

  summary() {
    const r = (n) => Math.round(n * 100) / 100
    return {
      tickRate: this.tickRate,
      tick: this.tick,
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
