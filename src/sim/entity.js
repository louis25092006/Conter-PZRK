import { Vector2 } from './vector.js'

// Базовий клас для всього, що живе у світі: кораблі, кулі, астероїди,
// бонуси, вибухи. Від нього успадковуємось РІВНО на один рівень
// (Ship extends Entity), усе складніше — композиція (див. components.js).

export class Entity {
  // приватний статичний лічильник: спільний для всіх сутностей,
  // ззовні його не можна ні прочитати, ні зіпсувати
  static #nextId = 1
  #id = Entity.#nextId++

  constructor({ kind, x = 0, y = 0, vx = 0, vy = 0, angle = 0, radius = 10, team = 'neutral' } = {}) {
    this.kind = kind // 'ship' | 'bullet' | 'asteroid' | 'pickup' | 'explosion'
    this.team = team // 'player' | 'enemy' | 'neutral'
    this.pos = new Vector2(x, y)
    this.vel = new Vector2(vx, vy)
    this.angle = angle
    this.radius = radius
    this.alive = true // false => світ прибере сутність наприкінці кроку
    this.collidable = true

    // стан на початку кроку — для інтерполяції в рендері
    this.prevPos = this.pos
    this.prevAngle = angle
  }

  get id() {
    return this.#id
  }

  savePrevious() {
    // вектори незмінні, тому копіювати не треба — досить посилання
    this.prevPos = this.pos
    this.prevAngle = this.angle
  }

  // скинути інтерполяцію (після телепорту / wrap / респауну)
  snapPrevious() {
    this.savePrevious()
  }

  // eslint-disable-next-line no-unused-vars
  update(dt, world) {
    this.pos = this.pos.add(this.vel.scale(dt))
  }

  kill() {
    this.alive = false
  }
}
