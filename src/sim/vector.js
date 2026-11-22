// Vector2 — незмінний (immutable) 2D-вектор.
// Усі методи ПОВЕРТАЮТЬ НОВИЙ вектор: a.add(b) ніколи не змінює a.
// Завдяки цьому previous/current-стани для інтерполяції можна зберігати
// простим присвоєнням посилання (prevPos = pos) — ніхто їх потім не зіпсує.

export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
  }

  static fromAngle(angle, length = 1) {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length)
  }

  static lerp(a, b, t) {
    return new Vector2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
  }

  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y)
  }

  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y)
  }

  scale(k) {
    return new Vector2(this.x * k, this.y * k)
  }

  dot(v) {
    return this.x * v.x + this.y * v.y
  }

  length() {
    return Math.hypot(this.x, this.y)
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y
  }

  distanceTo(v) {
    return Math.hypot(this.x - v.x, this.y - v.y)
  }

  normalize() {
    const len = this.length()
    return len === 0 ? new Vector2(0, 0) : new Vector2(this.x / len, this.y / len)
  }

  rotate(angle) {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c)
  }

  angle() {
    return Math.atan2(this.y, this.x)
  }

  clampLength(max) {
    const len = this.length()
    return len > max ? this.scale(max / len) : this
  }
}

// Зводить кут у діапазон [-π, π] — найкоротший поворот по колу.
export function wrapAngle(a) {
  const tau = Math.PI * 2
  a = ((a % tau) + tau) % tau
  return a > Math.PI ? a - tau : a
}
