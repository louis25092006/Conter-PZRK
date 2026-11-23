// Lab 7, M4: боти — та сама команда {turn, thrust, fire}, що й у людини.
import { describe, test, expect } from 'vitest'
import { World } from '@conter/shared/sim/world.ts'
import { Ship } from '@conter/shared/sim/ship.ts'
import { Asteroid } from '@conter/shared/sim/asteroid.ts'
import { ARENA_SIZE } from '@conter/shared/sim/arena.ts'
import { createRng } from '@conter/shared/sim/random.ts'
import { DEFAULT_ARENA, type ArenaConfig } from '@conter/shared/arena-config.ts'
import { Bot } from '../src/bot.ts'
import { Match } from '../src/match.ts'
import { NetworkInput } from '../src/player-input.ts'
import { toSeq } from '@conter/shared/types.ts'
import type { InputMsg } from '@conter/shared/protocol.ts'

const EMPTY: ArenaConfig = {
  ...DEFAULT_ARENA,
  startAsteroids: 0,
  asteroidsBase: 0,
  asteroidsCap: 0,
  enemiesBase: 0,
  enemiesCap: 0,
  asteroidEvery: 1e9,
  enemyEvery: 1e9,
  pickupEvery: 1e9,
}

function setup(): { world: World; me: Ship; bot: Bot } {
  const world = new World({ ...ARENA_SIZE, arena: EMPTY })
  const me = world.spawn(new Ship({ x: 400, y: 450, angle: 0 }))
  return { world, me, bot: new Bot(world, me.id, createRng(1)) }
}

describe('Bot', () => {
  test('ціль прямо по курсу в межах дальності → стріляє, не повертає', () => {
    const { world, bot } = setup()
    world.spawn(new Asteroid({ size: 2, x: 750, y: 450, rng: createRng(2) }))
    const cmd = bot.decide()
    expect(cmd.fire).toBe(true)
    expect(cmd.turn).toBe(0)
  })
  test('ціль збоку → повертає до неї і ще не стріляє', () => {
    const { world, bot } = setup()
    world.spawn(new Asteroid({ size: 2, x: 400, y: 800, rng: createRng(2) })) // знизу (y росте вниз)
    const cmd = bot.decide()
    expect(cmd.turn).toBe(1)
    expect(cmd.fire).toBe(false)
  })
  test('астероїд летить просто на бота і вже близько → ухиляється з газом, не стріляє', () => {
    const { world, bot } = setup()
    world.spawn(new Asteroid({ size: 1, x: 480, y: 450, vx: -200, rng: createRng(3) }))
    const cmd = bot.decide()
    expect(cmd.thrust).toBe(true)
    expect(cmd.fire).toBe(false)
  })
  test('take(): одна команда на крок, seq зростає (як у людини)', () => {
    const { bot } = setup()
    const a = bot.take()
    const b = bot.take()
    expect(a).toHaveLength(1)
    expect(b[0]?.seq).toBe(toSeq((a[0]?.seq ?? 0) + 1))
  })
})

describe('Match з ботами', () => {
  test('8 ботів за 30 с гри збивають щось і нікого не «гублять»', () => {
    const match = new Match({ arena: DEFAULT_ARENA })
    for (let i = 0; i < 8; i++) match.addBot(`bot-${i}`)
    for (let t = 0; t < 30 * 30; t++) match.step() // 900 тіків = 30 с гри (без таймера — швидко)
    let score = 0
    for (const e of match.world.ofKind('ship')) if (e.team === 'player') score += e.score
    expect(match.botCount).toBe(8)
    expect(score).toBeGreaterThan(0)
  })
  test('мережеві команди отримує лише людина, бот — ні', () => {
    const match = new Match({ arena: DEFAULT_ARENA })
    match.addBot('bot-1')
    match.addPlayer('human')
    const cmd: InputMsg = { type: 'input', seq: toSeq(1), turn: 0, thrust: true, fire: false }
    expect(match.pushInput('bot-1', cmd)).toBe(false)
    expect(match.pushInput('human', cmd)).toBe(true)
  })
  test('NetworkInput: порожня черга → жодної команди (SKIP) і кредит на наздоганяння', () => {
    const stats = { droppedInputs: 0, starvedSteps: 0, catchUpSteps: 0 }
    const input = new NetworkInput(stats)
    expect(input.take()).toEqual([])
    expect(stats.starvedSteps).toBe(1)
    for (let s = 1; s <= 5; s++)
      input.push({ type: 'input', seq: toSeq(s), turn: 0, thrust: false, fire: false })
    expect(input.take().length).toBe(2) // одна своя + одна в рахунок кредиту (2 лишаються в буфері)
    expect(stats.catchUpSteps).toBe(1)
  })
})
