import type { AnyEntity, World } from './world.ts'
import type { CollisionDetector } from './collision.ts'

// Lab 7, M3: просторова сітка (spatial hash) замість наївного O(n²).
// Профіль сервера: findCollisions ≈ 10% CPU при 64 гравцях (500+ сутностей → 130 000 пар за крок).
//
// Арену ділимо на клітинки cell×cell. Кожну сутність кладемо в усі клітинки, які зачіпає її
// обмежувальний квадрат. Перевіряємо лише пари В ОДНІЙ клітинці — це в сотні разів менше пар.
//
// Дві тонкощі:
//  1) пара може опинитися в кількох спільних клітинках — звітуємо її лише в ОДНІЙ: там, де лежить
//     лівий верхній кут перетину їхніх квадратів (так дублікатів немає без жодного Set);
//  2) порядок пар впливає на результат (куля, що зачепила два астероїди, вбиває перший у списку),
//     тож у кінці сортуємо пари в ТОМУ САМОМУ порядку, що й наївна версія — симуляція лишається
//     біт-у-біт такою ж (тест порівнює обидва детектори на випадкових світах).
//
// Пам'ять: лічильники й записи — у типізованих масивах, що переживають кроки (ростуть за потреби),
// тож щокроку детектор майже нічого не алокує.

export function createSpatialHash(cell = 64): CollisionDetector {
  let list: AnyEntity[] = []
  let x0 = new Int32Array(0)
  let y0 = new Int32Array(0)
  let x1 = new Int32Array(0)
  let y1 = new Int32Array(0)
  let counts = new Int32Array(0)
  let entries = new Int32Array(0)
  const pairA: number[] = []
  const pairB: number[] = []

  return function detect(world: World): Iterable<readonly [AnyEntity, AnyEntity]> {
    const cols = Math.ceil(world.width / cell) + 1
    const rows = Math.ceil(world.height / cell) + 1
    const cells = cols * rows
    list = []
    for (const e of world) if (e.alive && e.collidable) list.push(e)
    const n = list.length
    if (x0.length < n) {
      const cap = Math.max(n, x0.length * 2, 64)
      x0 = new Int32Array(cap)
      y0 = new Int32Array(cap)
      x1 = new Int32Array(cap)
      y1 = new Int32Array(cap)
    }
    if (counts.length < cells + 1) counts = new Int32Array(cells + 1)
    counts.fill(0)

    // 1) діапазон клітинок для кожної сутності + підрахунок записів у кожній клітинці
    const clamp = (v: number, max: number): number => (v < 0 ? 0 : v > max ? max : v)
    let total = 0
    for (let i = 0; i < n; i++) {
      const e = list[i]
      if (!e) continue
      const cx0 = clamp(Math.floor((e.pos.x - e.radius) / cell), cols - 1)
      const cy0 = clamp(Math.floor((e.pos.y - e.radius) / cell), rows - 1)
      const cx1 = clamp(Math.floor((e.pos.x + e.radius) / cell), cols - 1)
      const cy1 = clamp(Math.floor((e.pos.y + e.radius) / cell), rows - 1)
      x0[i] = cx0
      y0[i] = cy0
      x1[i] = cx1
      y1[i] = cy1
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = cy * cols + cx + 1
          counts[c] = (counts[c] ?? 0) + 1
          total++
        }
    }
    // 2) префіксні суми: counts[c] — де в entries починається клітинка c
    for (let c = 1; c <= cells; c++) counts[c] = (counts[c] ?? 0) + (counts[c - 1] ?? 0)
    if (entries.length < total) entries = new Int32Array(Math.max(total, entries.length * 2))
    const fill = counts.slice(0, cells) // курсори запису (одна алокація на крок, ~375 чисел)
    for (let i = 0; i < n; i++)
      for (let cy = y0[i] ?? 0; cy <= (y1[i] ?? -1); cy++)
        for (let cx = x0[i] ?? 0; cx <= (x1[i] ?? -1); cx++) {
          const c = cy * cols + cx
          const at = fill[c] ?? 0
          entries[at] = i
          fill[c] = at + 1
        }

    // 3) пари всередині кожної клітинки (індекси i < j — як у наївній версії)
    pairA.length = 0
    pairB.length = 0
    for (let c = 0; c < cells; c++) {
      const start = counts[c] ?? 0
      const end = counts[c + 1] ?? 0
      for (let p = start; p < end; p++) {
        const ip = entries[p] ?? 0
        for (let q = p + 1; q < end; q++) {
          const iq = entries[q] ?? 0
          const i = ip < iq ? ip : iq
          const j = ip < iq ? iq : ip
          // звітуємо лише в клітинці кута перетину квадратів — без дублікатів
          const ox = Math.max(x0[i] ?? 0, x0[j] ?? 0)
          const oy = Math.max(y0[i] ?? 0, y0[j] ?? 0)
          if (oy * cols + ox !== c) continue
          const a = list[i]
          const b = list[j]
          if (!a || !b) continue
          const r = a.radius + b.radius
          const dx = a.pos.x - b.pos.x
          const dy = a.pos.y - b.pos.y
          if (dx * dx + dy * dy < r * r) {
            pairA.push(i)
            pairB.push(j)
          }
        }
      }
    }

    // 4) той самий порядок, що в наївному O(n²): за i, потім за j
    const order = pairA
      .map((_, k) => k)
      .sort((p, q) => (pairA[p] ?? 0) - (pairA[q] ?? 0) || (pairB[p] ?? 0) - (pairB[q] ?? 0))
    const out: (readonly [AnyEntity, AnyEntity])[] = []
    for (const k of order) {
      const a = list[pairA[k] ?? -1]
      const b = list[pairB[k] ?? -1]
      if (a && b) out.push([a, b])
    }
    return out
  }
}
