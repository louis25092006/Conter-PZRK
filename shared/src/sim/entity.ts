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
  // приватний статичний лічильник: спільний для всіх сутностей,
  // ззовні його не можна ні прочитати, ні зіпсувати
  static #nextId = 1
  readonly #id: EntityId = toEntityId(Entity.#nextId++)

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
