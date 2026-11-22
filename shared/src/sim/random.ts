// Детермінований генератор випадкових чисел (mulberry32).
// Math.random() у симуляції ламає детермінізм із Lab 1: два запуски
// з однаковим вводом дали б різних ворогів. Із seed — однакових.

export interface Rng {
  next(): number // [0, 1)
  range(min: number, max: number): number
  int(min: number, max: number): number // обидві межі включно
  chance(p: number): boolean
  pick<T>(items: readonly T[]): T
}

export function createRng(seed = 1): Rng {
  let state = seed >>> 0

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    chance: (p) => next() < p,
    pick<T>(items: readonly T[]): T {
      const item = items[Math.floor(next() * items.length)]
      // noUncheckedIndexedAccess: items[i] має тип T | undefined — порожній масив тут помилка програміста
      if (item === undefined) throw new RangeError('pick() from an empty array')
      return item
    },
  }
}
