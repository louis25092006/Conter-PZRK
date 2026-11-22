import { createRng } from './random.js'
import { findCollisions, resolveCollisions } from './collision.js'
import { homingSystem } from './components.js'
import { spawnerSystem, DEFAULT_ARENA } from './spawner.js'
import { Vector2 } from './vector.js'

// Менеджер сутностей: тримає всі "речі у світі" в Map<id, Entity>
// і раз за крок симуляції оновлює їх, рахує колізії, прибирає мертвих.
//
// Lab 3: World — це ще й EventTarget (шина подій). Симуляція НЕ імпортує
// ні звук, ні HUD: вона лише оголошує "fired", "hit", "exploded", "pickup", "score",
// а хто захоче — підпишеться (audio.js, hud.js). EventTarget є і в браузері, і в Node.
export class World extends EventTarget {
  #entities = new Map()
  #pending = [] // народжені під час кроку — додамо після нього
  #stepping = false

  constructor({
    width,
    height,
    arena = DEFAULT_ARENA,
    seed = arena.seed ?? 1,
    detectCollisions = findCollisions,
  } = {}) {
    super()
    this.width = width
    this.height = height
    this.arena = arena // параметри арени з arenas.json (скільки ворогів, астероїдів, колір неба)
    this.rng = createRng(seed)
    this.detectCollisions = detectCollisions // систему колізій можна підмінити
    this.time = 0
    this.score = 0
    this.deaths = 0
    this.input = null
    this.director = { asteroid: 5, enemy: 4, pickup: 7 } // таймери спавнера
  }

  // оголосити подію для всіх підписників (звук, HUD...)
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }

  addScore(delta, pos) {
    this.score += delta
    this.emit('score', { delta, total: this.score, x: pos.x, y: pos.y })
  }

  spawn(entity) {
    // Map при for…of бачить елементи, додані ПІД ЧАС обходу: куля, випущена
    // в update(), оновилась би ще на цьому ж кроці. Тому відкладаємо.
    if (this.#stepping) this.#pending.push(entity)
    else this.#entities.set(entity.id, entity)
    return entity
  }

  // відкладене видалення: лише позначаємо, приберемо в кінці кроку
  despawn(id) {
    const e = this.#entities.get(id)
    if (e) e.kill()
  }

  get(id) {
    return this.#entities.get(id)
  }

  get size() {
    return this.#entities.size
  }

  *[Symbol.iterator]() {
    yield* this.#entities.values()
  }

  *ofKind(kind) {
    for (const e of this) if (e.kind === kind) yield e
  }

  count(predicate) {
    let n = 0
    for (const e of this) if (e.alive && predicate(e)) n++
    return n
  }

  nearest(pos, predicate, maxDist = Infinity) {
    let best = null
    let bestDist = maxDist * maxDist
    for (const e of this) {
      if (!predicate(e)) continue
      const d = e.pos.sub(pos).lengthSq()
      if (d < bestDist) {
        bestDist = d
        best = e
      }
    }
    return best
  }

  // випадкова точка подалі від астероїдів і ворогів (для респауну та бонусів)
  findSafeSpot(minDist = 170) {
    const margin = 60
    let spot = new Vector2(this.width / 2, this.height / 2)
    for (let attempt = 0; attempt < 40; attempt++) {
      spot = new Vector2(
        this.rng.range(margin, this.width - margin),
        this.rng.range(margin, this.height - margin),
      )
      const danger = this.nearest(
        spot,
        (e) =>
          e.alive &&
          e.collidable &&
          (e.kind === 'asteroid' || (e.kind === 'ship' && e.team === 'enemy') || e.kind === 'bullet'),
        minDist,
      )
      if (!danger) return spot
    }
    return spot
  }

  step(dt, input) {
    this.input = input
    this.time += dt
    this.#stepping = true

    for (const e of this) e.savePrevious()
    homingSystem(this, dt)
    for (const e of this) if (e.alive) e.update(dt, this)
    resolveCollisions(this, this.detectCollisions(this))
    spawnerSystem(this, dt)

    this.#stepping = false
    this.#sweep()
    for (const e of this.#pending) this.#entities.set(e.id, e)
    this.#pending.length = 0
  }

  #sweep() {
    // видаляти з Map під час for…of дозволено специфікацією,
    // але ми робимо це в одному місці й лише наприкінці кроку
    for (const [id, e] of this.#entities) if (!e.alive) this.#entities.delete(id)
  }
}
