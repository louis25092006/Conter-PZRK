import type { World } from './world.ts'

// Хеш стану світу (FNV-1a по бітах float64) — щоб перевірити детермінізм:
// той самий seed + ті самі команди → той самий хеш у Node і в браузері.
export function hashWorld(world: World): string {
  const view = new DataView(new ArrayBuffer(8))
  let h = 0x811c9dc5
  const mix = (n: number): void => {
    view.setFloat64(0, n)
    for (let i = 0; i < 8; i++) {
      h ^= view.getUint8(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  const entities = [...world].filter((e) => e.alive && e.kind !== 'explosion').sort((a, b) => a.id - b.id)
  mix(entities.length)
  for (const e of entities) {
    mix(e.pos.x)
    mix(e.pos.y)
    mix(e.vel.x)
    mix(e.vel.y)
    mix(e.angle)
  }
  mix(world.score)
  return h.toString(16).padStart(8, '0')
}
