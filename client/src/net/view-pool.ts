import { EFFECT_NAMES, type EffectName, type Team } from '../../../shared/src/types.ts'
import type { Crater, Speck } from '../../../shared/src/sim/asteroid.ts'
import type { ShipData } from '../../../shared/src/protocol.ts'
import type { AsteroidView, BulletView, PickupView, ShipView } from '../render/draw.ts'

// Lab 7, M3: об'єкти для малювання, які ПЕРЕВИКОРИСТОВУЮТЬСЯ з кадру в кадр.
// Профіль показав, що NetGame.view() був найбільшим «алокатором» (≈24% усіх байтів):
// щокадру нові {pos}, нові Map ефектів, нові Vector2 для кожної сутності.
// Тепер у кожного виду — пул: кадр бере перші N об'єктів і перезаписує їхні поля.
//
// Правило прихованих класів (hidden classes): усі поля задаються в конструкторі,
// в одному порядку, одного типу — тож об'єкти одного класу мають одну «форму»,
// і доступ slot.pos.x у drawShip лишається мономорфним (швидким).

export class MutPoint {
  x = 0
  y = 0
}

export class ShipSlot implements ShipView {
  readonly pos = new MutPoint()
  readonly prevPos = this.pos // інтерполяцію NetGame робить сам — prevPos = pos
  angle = 0
  prevAngle = 0
  id = 0
  team: Team = 'player'
  radius = 0
  thrust = false
  isWaitingRespawn = false
  invulnerable = 0
  readonly effects = new Map<EffectName, number>()
  hp = 0
  maxHp = 1
  name: string | undefined = undefined
  isMe = false
}

export class BulletSlot implements BulletView {
  readonly pos = new MutPoint()
  readonly prevPos = this.pos
  angle = 0
  prevAngle = 0
  team: Team = 'player'
  homing = false
  radius = 3
  readonly vel = new MutPoint()
}

export class AsteroidSlot implements AsteroidView {
  readonly pos = new MutPoint()
  readonly prevPos = this.pos
  angle = 0
  prevAngle = 0
  radius = 0
  homing = false
  variant = 0
  shape: readonly number[] = []
  craters: readonly Crater[] = []
  specks: readonly Speck[] = []
}

export class PickupSlot implements PickupView {
  readonly pos = new MutPoint()
  effect: EffectName = 'shield'
  ttl = 0
  radius = 13
}

export class Pool<T> {
  readonly #items: T[] = []
  readonly #make: () => T
  #used = 0
  constructor(make: () => T) {
    this.#make = make
  }
  reset(): void {
    this.#used = 0
  }
  next(): T {
    let item = this.#items[this.#used]
    if (item === undefined) {
      item = this.#make()
      this.#items.push(item)
    }
    this.#used++
    return item
  }
}

// ефекти без перебудови Map: міняємо лише те, що змінилось
export function syncEffects(target: Map<EffectName, number>, e: ShipData['effects']): void {
  for (const name of EFFECT_NAMES) {
    const v = e[name]
    if (v > 0) target.set(name, v)
    else if (target.has(name)) target.delete(name)
  }
}
