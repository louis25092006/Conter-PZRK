import { wrapAngle } from './vector.ts'
import type { Kind } from './entity.ts'
import type { Command } from './ship-physics.ts'
import type { Ship } from './ship.ts'
import type { World } from './world.ts'
import type { EffectName, Team } from '../types.ts'

// КОМПОЗИЦІЯ: поведінка, яку можна "причепити" до будь-якої сутності,
// незалежно від її класу. Усе тут — звичайні дані (рядки, числа),
// а системи (systems.ts) обробляють будь-кого, у кого є потрібне поле.

// ---------- Homing: самонаведення ----------
// Чіпляється і до кулі, і до астероїда — той випадок, де ієрархія класів зламалась би.
export interface HomingSpec {
  readonly turnRate: number
  readonly range: number
  readonly targetKinds: readonly Kind[]
  readonly ownTeam: Team
}

export function homing({
  turnRate = 3,
  range = 400,
  targetKinds = ['ship'],
  ownTeam = 'neutral',
}: Partial<HomingSpec> = {}): HomingSpec {
  return { turnRate, range, targetKinds, ownTeam }
}

// ---------- Controller: хто керує кораблем ----------
// ship.controller — це РЯДОК (дані), а не функція. Гравець і ворог —
// той самий клас Ship, відрізняється лише "мозок".
// Lab 5: сервер може дати кілька команд за крок (наздоганяє після затримки) — тому масив.

const IDLE: Command = Object.freeze({ turn: 0, thrust: false, fire: false })

export type ControllerName = 'input' | 'chaser'
type Controller = (ship: Ship, world: World) => Command | readonly Command[]

// Record<ControllerName, …> — компілятор вимагає реалізацію для КОЖНОЇ назви
export const controllers: Record<ControllerName, Controller> = {
  // гравцем керують КОМАНДИ (з мережі або з клавіатури через клієнта)
  input(ship, world) {
    return world.inputs.get(ship.id) ?? IDLE
  },

  // простий ворог-переслідувач: розвертається до найближчого чужого корабля,
  // летить до нього і стріляє, коли ціль майже точно попереду
  chaser(ship, world) {
    const target = world.nearest(ship.pos, (t) => t.kind === 'ship' && t.team !== ship.team && t.collidable)
    if (!target) return { turn: 0.3, thrust: false, fire: false } // кружляє, поки гравець на респауні

    const to = target.pos.sub(ship.pos)
    const diff = wrapAngle(to.angle() - ship.angle)
    const dist = to.length()
    return {
      turn: Math.max(-1, Math.min(1, diff * 3)),
      thrust: dist > 170 && Math.abs(diff) < 1.2,
      fire: dist < 420 && Math.abs(diff) < 0.2,
    }
  },
}

// ---------- Effects: тимчасові бонуси на кораблі ----------
export interface EffectInfo {
  readonly duration: number
  readonly label: string
  readonly color: string
  readonly letter: string
}

export const EFFECTS: Readonly<Record<EffectName, EffectInfo>> = {
  shield: { duration: 6, label: 'SHIELD', color: '#5ad1ff', letter: 'S' },
  rapid: { duration: 6, label: 'RAPID FIRE', color: '#ffd166', letter: 'R' },
  homing: { duration: 8, label: 'HOMING', color: '#c77dff', letter: 'H' },
}

export function tickEffects(effects: Map<EffectName, number>, dt: number): void {
  for (const [name, left] of effects) {
    if (left - dt <= 0) effects.delete(name)
    else effects.set(name, left - dt)
  }
}
