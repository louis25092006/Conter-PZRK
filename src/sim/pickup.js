import { Entity } from './entity.js'

// Бонус: стоїть на місці, з ним можна зіткнутись, але це НЕ корабель.
// Що саме він дає — просто рядок effect ('shield' | 'rapid' | 'homing').
export class Pickup extends Entity {
  constructor({ effect, ttl = 12, ...rest } = {}) {
    super({ kind: 'pickup', radius: 13, ...rest })
    this.effect = effect
    this.ttl = ttl
  }

  update(dt) {
    // позиція не змінюється — super.update не викликаємо
    this.ttl -= dt
    if (this.ttl <= 0) this.kill()
  }
}
