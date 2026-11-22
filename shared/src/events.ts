import type { z } from 'zod'
import type {
  ExplodedEventSchema,
  FiredEventSchema,
  GameEventSchema,
  HitEventSchema,
  PickupEventSchema,
  ScoreEventSchema,
} from './protocol.ts'

// Події гри — що сталося за крок. Одна union-модель на все:
//  - симуляція оголошує їх через world.events (Bus<GameEvents>);
//  - сервер кладе їх у знімок (JSON/бінарний), клієнт отримує ті самі об'єкти;
//  - звук і HUD слухають їх, не знаючи, звідки вони прийшли (локальний світ чи мережа).
// Типи ВИВЕДЕНІ зі схем у protocol.ts — джерело правди одне.

export type FiredEvent = z.infer<typeof FiredEventSchema>
export type HitEvent = z.infer<typeof HitEventSchema>
export type ExplodedEvent = z.infer<typeof ExplodedEventSchema>
export type PickupEvent = z.infer<typeof PickupEventSchema>
export type ScoreEvent = z.infer<typeof ScoreEventSchema>
export type GameEvent = z.infer<typeof GameEventSchema>
export type GameEventType = GameEvent['type']

// Карта для шини: { fired: FiredEvent; hit: HitEvent; … } — ВИВЕДЕНА з union автоматично.
// Додаси нову подію в union — вона сама з'явиться в шині з правильним типом.
export type GameEvents = { [E in GameEvent as E['type']]: E }

export const GAME_EVENT_TYPES: readonly GameEventType[] = ['fired', 'hit', 'exploded', 'pickup', 'score']
