import { Vector2 } from './vector.ts'
import { toEntityId, type EntityId, type Team } from '../types.ts'
import type { World } from './world.ts'

// Базовий клас для всього, що живе у світі: кораблі, кулі, астероїди,
// бонуси, вибухи. Від нього успадковуємось РІВНО на один рівень
// (Ship extends Entity), усе складніше — композиція (див. components.ts).

export type Kind = 'ship' | 'bullet' | 'asteroid' | 'pickup' | 'explosion'

export interface EntityInit {
  x?: number
  y?: number
  vx?: number
  vy?: number
  angle?: number
  radius?: number
  team?: Team
}

export abstract class Entity {
  // Lab 7: id видає СВІТ у spawn() — свій лічильник у кожного World.
  // Раніше тут був статичний лічильник, спільний для всіх світів: два однакові матчі
  // отримували різні id (тест детермінізму зі знімками це впіймав), а матчі на сервері
  // «з'їдали» id один в одного. 0 = сутність ще не у світі.
  #id: EntityId = toEntityId(0)

  // Lab 6: kind — abstract: кожен підклас зобов'язаний оголосити СВІЙ літерал ('ship', 'bullet'…).
  // Саме на ньому TypeScript потім звужує union сутностей (див. AnyEntity у world.ts).
  abstract readonly kind: Kind

  team: Team
  pos: Vector2
  vel: Vector2
  angle: number
  radius: number
  alive = true // false => світ прибере сутність наприкінці кроку
  collidable = true
  // стан на початку кроку — для інтерполяції в рендері
  prevPos: Vector2
  prevAngle: number

  constructor({ x = 0, y = 0, vx = 0, vy = 0, angle = 0, radius = 10, team = 'neutral' }: EntityInit = {}) {
    this.team = team
    this.pos = new Vector2(x, y)
    this.vel = new Vector2(vx, vy)
    this.angle = angle
    this.radius = radius
    this.prevPos = this.pos
    this.prevAngle = angle
  }

  get id(): EntityId {
    return this.#id
  }

  // викликає лише World.spawn(); вдруге — помилка (одна сутність не живе у двох світах)
  bindId(id: EntityId): void {
    if (this.#id !== 0) throw new Error(`entity already has id ${this.#id}`)
    this.#id = id
  }

  savePrevious(): void {
    // вектори незмінні, тому копіювати не треба — досить посилання
    this.prevPos = this.pos
    this.prevAngle = this.angle
  }

  // скинути інтерполяцію (після телепорту / wrap / респауну)
  snapPrevious(): void {
    this.savePrevious()
  }

  update(dt: number, _world: World): void {
    this.pos = this.pos.add(this.vel.scale(dt))
  }

  kill(): void {
    this.alive = false
  }
}
