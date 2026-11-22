import { Entity } from './entity.js'
import { wrapAround } from './arena.js'

export class Bullet extends Entity {
  constructor({ ttl = 1.2, damage = 1, ownerId = null, ...rest } = {}) {
    super({ kind: 'bullet', radius: 3, ...rest })
    this.ttl = ttl // time-to-live: скільки секунд куля ще летить
    this.damage = damage
    this.ownerId = ownerId
    this.homing = null // компонент може бути причеплений кораблем (бонус HOMING)
    this.spawnSeq = 0 // номер команди гравця, якою випущено кулю (Lab 5: передбачення)
  }

  update(dt, world) {
    this.ttl -= dt
    if (this.ttl <= 0) {
      this.kill()
      return
    }
    super.update(dt, world)
    wrapAround(this, world.width, world.height)
  }
}
