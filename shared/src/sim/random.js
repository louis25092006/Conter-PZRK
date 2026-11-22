// Детермінований генератор випадкових чисел (mulberry32).
// Math.random() у симуляції ламає детермінізм із Lab 1: два запуски
// з однаковим вводом дали б різних ворогів. Із seed — однакових.

export function createRng(seed = 1) {
  let state = seed >>> 0

  function next() {
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
    pick: (items) => items[Math.floor(next() * items.length)],
  }
}
