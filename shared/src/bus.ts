// Типізована шина подій. Замінює EventTarget + CustomEvent (Lab 3):
// у CustomEvent поле detail має тип any — компілятор не знає, що всередині 'score'.
// Тут карта подій E описує, яка подія несе які дані:
//   const bus = new Bus<{ score: { delta: number }; reset: void }>()
//   bus.on('score', (d) => d.delta)   // d: { delta: number }
//   bus.emit('score', { delta: '5' }) // ПОМИЛКА компіляції: '5' — не number
// Без EventTarget ще й без жодного приведення типів (as).

export type Listener<T> = (detail: T) => void

export class Bus<E extends object> {
  // для кожної події — свій набір слухачів правильного типу (mapped type)
  #listeners: { [K in keyof E]?: Set<Listener<E[K]>> } = {}

  on<K extends keyof E>(type: K, fn: Listener<E[K]>): () => void {
    const set = this.#listeners[type] ?? new Set<Listener<E[K]>>()
    this.#listeners[type] = set
    set.add(fn)
    return () => this.off(type, fn) // зручно: повертає функцію відписки
  }

  off<K extends keyof E>(type: K, fn: Listener<E[K]>): void {
    this.#listeners[type]?.delete(fn)
  }

  emit<K extends keyof E>(type: K, detail: E[K]): void {
    const set = this.#listeners[type]
    if (!set) return
    for (const fn of [...set]) fn(detail) // копія: слухач може відписатися під час виклику
  }

  clear(): void {
    this.#listeners = {}
  }
}
