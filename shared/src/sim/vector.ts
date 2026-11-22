// Vector2 — незмінний (immutable) 2D-вектор.
// Усі методи ПОВЕРТАЮТЬ НОВИЙ вектор: a.add(b) ніколи не змінює a.
// Lab 6: поля x і y — readonly, тож випадково змінити вектор (v.x = 5) тепер не дасть компілятор.

export interface Point {
  readonly x: number
  readonly y: number
}

export class Vector2 implements Point {
  readonly x: number
  readonly y: number

  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
  }

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length)
  }

  static lerp(a: Point, b: Point, t: number): Vector2 {
    return new Vector2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
  }

  add(v: Point): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y)
  }

  sub(v: Point): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y)
  }

  scale(k: number): Vector2 {
    return new Vector2(this.x * k, this.y * k)
  }

  dot(v: Point): number {
    return this.x * v.x + this.y * v.y
  }

  length(): number {
    return Math.hypot(this.x, this.y)
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y
  }

  distanceTo(v: Point): number {
    return Math.hypot(this.x - v.x, this.y - v.y)
  }

  normalize(): Vector2 {
    const len = this.length()
    return len === 0 ? new Vector2(0, 0) : new Vector2(this.x / len, this.y / len)
  }

  rotate(angle: number): Vector2 {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c)
  }

  angle(): number {
    return Math.atan2(this.y, this.x)
  }

  clampLength(max: number): Vector2 {
    const len = this.length()
    return len > max ? this.scale(max / len) : this
  }
}

// Зводить кут у діапазон [-π, π] — найкоротший поворот по колу.
export function wrapAngle(a: number): number {
  const tau = Math.PI * 2
  a = ((a % tau) + tau) % tau
  return a > Math.PI ? a - tau : a
}
