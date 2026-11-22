import { Entity, type EntityInit } from './entity.ts'
import type { EffectName } from '../types.ts'

// Бонус: стоїть на місці, з ним можна зіткнутись, але це НЕ корабель.
// Що саме він дає — просто рядок effect ('shield' | 'rapid' | 'homing').
export interface PickupInit extends EntityInit {
  effect: EffectName
  ttl?: number
}

export class Pickup extends Entity {
  readonly kind: 'pickup' = 'pickup'
  effect: EffectName
  ttl: number

  constructor({ effect, ttl = 12, ...rest }: PickupInit) {
    super({ radius: 13, ...rest })
    this.effect = effect
    this.ttl = ttl
  }

  override update(dt: number): void {
    // позиція не змінюється — super.update не викликаємо
    this.ttl -= dt
    if (this.ttl <= 0) this.kill()
  }
}
