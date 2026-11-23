import { PLAYER_SHIP, IDLE, BULLET_SPEED, type Command } from '@conter/shared/sim/ship-physics.ts'
import { toSeq, type EntityId } from '@conter/shared/types.ts'
import type { World } from '@conter/shared/sim/world.ts'
import type { Rng } from '@conter/shared/sim/random.ts'
import type { PlayerInput } from './player-input.ts'

// Lab 7, M4: бот на сервері. Керує літаком ТИМИ САМИМИ командами {turn, thrust, fire},
// що й людина, — лише рішення ухвалює код, а не клавіатура. Три поведінки за пріоритетом:
//   1) ухилитися — астероїд або чужа куля летить на нас і вже близько;
//   2) переслідувати — найближчий ворог чи астероїд, з упередженням (стріляємо туди, де ціль БУДЕ);
//   3) стріляти — коли ніс дивиться на ціль і вона в межах дальності.

const EVADE_RADIUS = 110
const FIRE_RANGE = 520
const FIRE_CONE = 0.18 // рад: наскільки точно треба навестися, щоб стріляти
const CRUISE_DIST = 240 // ближче — не газуємо, щоб не врізатися в ціль

function angleDiff(target: number, current: number): number {
  let d = target - current
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

// найкоротший вектор з урахуванням того, що арена «загортається» по краях
function wrapped(d: number, size: number): number {
  if (d > size / 2) return d - size
  if (d < -size / 2) return d + size
  return d
}

export class Bot implements PlayerInput {
  readonly kind = 'bot'
  readonly #world: World
  readonly #shipId: EntityId
  readonly #rng: Rng
  #seq = 0
  #wander = 0 // дрібна випадковість, щоб боти не літали однаково

  constructor(world: World, shipId: EntityId, rng: Rng) {
    this.#world = world
    this.#shipId = shipId
    this.#rng = rng
  }

  take(): readonly Command[] {
    return [{ ...this.decide(), seq: toSeq(++this.#seq) }]
  }

  decide(): Command {
    const w = this.#world
    const me = w.get(this.#shipId)
    if (me?.kind !== 'ship' || !me.alive || me.isWaitingRespawn) return IDLE

    let threat: { dx: number; dy: number; d: number } | null = null
    let target: { dx: number; dy: number; d: number; vx: number; vy: number } | null = null
    for (const e of w) {
      if (!e.alive || e === me) continue
      const dx = wrapped(e.pos.x - me.pos.x, w.width)
      const dy = wrapped(e.pos.y - me.pos.y, w.height)
      const d = Math.hypot(dx, dy)
      const hostileBullet = e.kind === 'bullet' && e.team !== me.team
      if ((e.kind === 'asteroid' || hostileBullet) && d < EVADE_RADIUS + e.radius) {
        // летить на нас? (відносна швидкість спрямована до нас)
        const closing = (e.vel.x - me.vel.x) * dx + (e.vel.y - me.vel.y) * dy < 0
        if (closing && (!threat || d < threat.d)) threat = { dx, dy, d }
      }
      const isTarget = (e.kind === 'ship' && e.team === 'enemy') || e.kind === 'asteroid'
      if (isTarget && (!target || d < target.d)) target = { dx, dy, d, vx: e.vel.x, vy: e.vel.y }
    }

    if (threat) {
      // ухиляємося перпендикулярно до загрози, з газом
      const away = Math.atan2(-threat.dy, -threat.dx) + (this.#rng.next() < 0.5 ? 0.6 : -0.6)
      const turn = Math.sign(angleDiff(away, me.angle))
      return { turn, thrust: true, fire: false }
    }
    if (!target) {
      this.#wander += (this.#rng.next() - 0.5) * 0.2
      return { turn: Math.sign(this.#wander), thrust: this.#rng.next() < 0.3, fire: false }
    }

    // упередження: куля летить d / BULLET_SPEED секунд — ціль за цей час зсунеться
    const t = target.d / BULLET_SPEED
    const aim = Math.atan2(target.dy + target.vy * t, target.dx + target.vx * t)
    const diff = angleDiff(aim, me.angle)
    const turn = Math.abs(diff) < PLAYER_SHIP.turnSpeed / 60 ? 0 : Math.sign(diff)
    return {
      turn,
      thrust: target.d > CRUISE_DIST && Math.abs(diff) < 1,
      fire: Math.abs(diff) < FIRE_CONE && target.d < FIRE_RANGE,
    }
  }
}
