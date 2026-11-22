import { z } from 'zod'

// Параметри арени (файл client/public/assets/arenas.json).
// Одна zod-схема дає І тип (ArenaConfig), І перевірку файлу в рантаймі —
// сервер не стартує з помилкою в конфігу, клієнт не грає з битим JSON.
export const ArenaConfigSchema = z.object({
  name: z.string().min(1),
  seed: z.number().int().nonnegative().default(1),
  sky: z.string().default('#000000'),
  startAsteroids: z.number().int().min(0).max(20),
  asteroidEvery: z.number().positive(),
  asteroidsBase: z.number().int().min(0),
  asteroidsCap: z.number().int().min(0),
  homingChance: z.number().min(0).max(1),
  enemyEvery: z.number().positive(),
  enemiesBase: z.number().int().min(0),
  enemiesCap: z.number().int().min(0),
  pickupEvery: z.number().positive(),
})
export type ArenaConfig = z.infer<typeof ArenaConfigSchema>

export const ArenasSchema = z.record(z.string(), ArenaConfigSchema)
export type Arenas = z.infer<typeof ArenasSchema>

// Те саме, що "classic" у arenas.json — на випадок, якщо World створено без конфігу (тести)
export const DEFAULT_ARENA: ArenaConfig = {
  name: 'Classic Sky',
  seed: 2026,
  sky: '#000000',
  startAsteroids: 2,
  asteroidEvery: 7,
  asteroidsBase: 2,
  asteroidsCap: 5,
  homingChance: 0.1,
  enemyEvery: 6,
  enemiesBase: 1,
  enemiesCap: 5,
  pickupEvery: 9,
}
