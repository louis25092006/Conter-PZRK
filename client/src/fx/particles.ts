// Lab 7, M4: частинки як «структура масивів» в одному Float32Array —
// 6 чисел на частинку: x, y, vx, vy, ttl, maxTtl. Жодних об'єктів на частинку,
// тож GC тут нічого прибирати; і такий буфер можна ПЕРЕДАТИ у Worker без копіювання.

export const STRIDE = 6
const DRAG = 0.985

export interface ParticleBuffer {
  data: Float32Array
  count: number
}

export function createParticles(capacity: number): ParticleBuffer {
  return { data: new Float32Array(capacity * STRIDE), count: 0 }
}

// вибух у точці: n частинок з випадковою швидкістю; rand — детермінований у тестах
export function burst(
  p: ParticleBuffer,
  x: number,
  y: number,
  n: number,
  speed: number,
  rand: () => number,
): void {
  const cap = p.data.length / STRIDE
  for (let i = 0; i < n && p.count < cap; i++) {
    const a = rand() * Math.PI * 2
    const s = speed * (0.3 + rand() * 0.7)
    const ttl = 0.4 + rand() * 0.6
    const o = p.count * STRIDE
    p.data[o] = x
    p.data[o + 1] = y
    p.data[o + 2] = Math.cos(a) * s
    p.data[o + 3] = Math.sin(a) * s
    p.data[o + 4] = ttl
    p.data[o + 5] = ttl
    p.count++
  }
}

// крок симуляції частинок; мертві видаляємо «swap-remove» (на їхнє місце — остання), без зсуву масиву
export function stepParticles(data: Float32Array, count: number, dt: number): number {
  let n = count
  for (let i = 0; i < n;) {
    const o = i * STRIDE
    const ttl = (data[o + 4] ?? 0) - dt
    if (ttl <= 0) {
      n--
      data.copyWithin(o, n * STRIDE, n * STRIDE + STRIDE)
      continue // на місці i тепер інша частинка — перевіряємо її
    }
    const vx = (data[o + 2] ?? 0) * DRAG
    const vy = (data[o + 3] ?? 0) * DRAG
    data[o] = (data[o] ?? 0) + vx * dt
    data[o + 1] = (data[o + 1] ?? 0) + vy * dt
    data[o + 2] = vx
    data[o + 3] = vy
    data[o + 4] = ttl
    i++
  }
  return n
}
