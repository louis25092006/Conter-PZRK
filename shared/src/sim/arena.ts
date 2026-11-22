import { Vector2 } from './vector.ts'
import type { Entity } from './entity.ts'

// Lab 5: розмір арени ФІКСОВАНИЙ і однаковий для всіх гравців і сервера
// (раніше арена = розмір вікна браузера — у мультиплеєрі так не можна).
// Клієнт масштабує картинку під своє вікно.
export const ARENA_SIZE = Object.freeze({ width: 1600, height: 900 })

// Переносить сутність на протилежний край, якщо вона вилетіла за межі.
// Повертає true, якщо був перенос, — тоді треба скинути інтерполяцію,
// інакше рендер на один кадр "протягне" сутність через увесь екран.
export function wrapAround(entity: Entity, width: number, height: number): boolean {
  let { x, y } = entity.pos
  let wrapped = false

  if (x < 0) {
    x += width
    wrapped = true
  } else if (x > width) {
    x -= width
    wrapped = true
  }
  if (y < 0) {
    y += height
    wrapped = true
  } else if (y > height) {
    y -= height
    wrapped = true
  }

  if (wrapped) {
    entity.pos = new Vector2(x, y)
    entity.snapPrevious()
  }
  return wrapped
}

// Відбиває сутність від країв арени (для астероїдів).
export function bounceOffEdges(entity: Entity, width: number, height: number): void {
  const r = entity.radius
  let { x, y } = entity.pos
  let { x: vx, y: vy } = entity.vel

  if (x < r && vx < 0) {
    x = r
    vx = -vx
  }
  if (x > width - r && vx > 0) {
    x = width - r
    vx = -vx
  }
  if (y < r && vy < 0) {
    y = r
    vy = -vy
  }
  if (y > height - r && vy > 0) {
    y = height - r
    vy = -vy
  }

  entity.pos = new Vector2(x, y)
  entity.vel = new Vector2(vx, vy)
}
