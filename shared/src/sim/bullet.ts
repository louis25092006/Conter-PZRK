import { Entity, type EntityInit } from './entity.ts'
import { wrapAround } from './arena.ts'
import type { HomingSpec } from './components.ts'
import type { World } from './world.ts'
import type { EntityId, Seq } from '../types.ts'

export interface BulletInit extends EntityInit {
  ttl?: number
  damage?: number
  ownerId?: EntityId | null
}

export class Bullet extends Entity {
  readonly kind: 'bullet' = 'bullet'
  ttl: number // time-to-live: скільки секунд куля ще летить
  damage: number
  ownerId: EntityId | null
  homing: HomingSpec | null = null // компонент може бути причеплений кораблем (бонус HOMING)
  spawnSeq: Seq | null = null // номер команди гравця, якою випущено кулю (Lab 5: передбачення)

  constructor({ ttl = 1.2, damage = 1, ownerId = null, ...rest }: BulletInit = {}) {
    super({ radius: 3, ...rest })
    this.ttl = ttl
    this.damage = damage
    this.ownerId = ownerId
  }

  override update(dt: number, world: World): void {
    this.ttl -= dt
    if (this.ttl <= 0) {
      this.kill()
      return
    }
    super.update(dt, world)
    wrapAround(this, world.width, world.height)
  }
}
