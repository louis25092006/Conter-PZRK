import { z } from 'zod'
import {
  isEntityId,
  isSeq,
  isTick,
  err,
  ok,
  type EntityId,
  type Result,
  type Seq,
  type Tick,
} from './types.ts'

// ======================================================================
//  ПРОТОКОЛ — єдине джерело правди (Lab 6).
//  zod-схема → тип (z.infer) → перевірка в рантаймі на КОЖНІЙ межі
//  (сервер ← клієнт, клієнт ← сервер, файли). Тип і перевірка не можуть розійтися,
//  бо тип ВИВЕДЕНИЙ зі схеми, а не написаний поруч від руки.
//  Ручний валідатор з Lab 4 (server/src/protocol.js) видалено.
// ======================================================================

export const PROTOCOL_VERSION = 1
export const MAX_MESSAGE_BYTES = 2048
export const MAX_NAME = 16
export const MAX_CHAT = 200

// Коди закриття WebSocket. 4000–4999 — діапазон для власних кодів застосунку.
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001, // сервер вимикається
  TOO_BIG: 1009, // ставить сама бібліотека ws, якщо перевищено maxPayload
  BAD_JSON: 4000,
  UNKNOWN_TYPE: 4001,
  BAD_SHAPE: 4002,
  JOIN_TIMEOUT: 4003,
  BAD_VERSION: 4004,
  RATE_LIMIT: 4005,
  ROOM_UNAVAILABLE: 4006, // кімнати немає або вона заповнена
  SERVER_FULL: 4007,
  SLOW_CLIENT: 4008,
  NOT_JOINED: 4009, // повідомлення до join
})
export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE]

// ---------- примітиви ----------
// z.custom з функцією-предикатом дає БРЕНДОВАНИЙ тип без приведення типів (as)
const EntityIdSchema = z.custom<EntityId>(isEntityId, 'expected uint32 entity id')
const TickSchema = z.custom<Tick>(isTick, 'expected uint32 tick')
const SeqSchema = z.custom<Seq>(isSeq, 'expected uint32 seq')
const TeamSchema = z.enum(['player', 'enemy', 'neutral'])
const EffectSchema = z.enum(['shield', 'rapid', 'homing'])
const TurnSchema = z.union([z.literal(-1), z.literal(0), z.literal(1)])
const Name = z.string().trim().min(1).max(MAX_NAME)

// ---------- клієнт → сервер ----------
export const JoinMessage = z.object({
  type: z.literal('join'),
  v: z.literal(PROTOCOL_VERSION),
  roomId: z.string().trim().min(1).max(64),
  name: Name,
})
export const ChatMessage = z.object({ type: z.literal('chat'), text: z.string().trim().min(1).max(MAX_CHAT) })
export const LeaveMessage = z.object({ type: z.literal('leave') })
// команда гравця (JSON-варіант; бінарний — codec/binary.ts). turn: 5 — це чит, схема його не пропустить
export const InputMessage = z
  .object({
    type: z.literal('input'),
    seq: SeqSchema,
    turn: TurnSchema,
    thrust: z.boolean(),
    fire: z.boolean(),
  })
  .readonly()
export const PingMessage = z.object({ type: z.literal('ping'), t: z.number().nonnegative().finite() })
export const NetsimMessage = z.object({
  type: z.literal('netsim'),
  lag: z.number().min(0).max(1000),
  jitter: z.number().min(0).max(500),
  drop: z.number().min(0).max(0.5),
})

export const ClientMessageSchema = z.discriminatedUnion('type', [
  JoinMessage,
  ChatMessage,
  LeaveMessage,
  InputMessage,
  PingMessage,
  NetsimMessage,
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>
export type InputMsg = z.infer<typeof InputMessage>
export type NetsimConfig = Omit<z.infer<typeof NetsimMessage>, 'type'>

// ---------- знімок світу (сервер → клієнт, 30/с) ----------
const Common = { id: EntityIdSchema, x: z.number(), y: z.number(), angle: z.number() }
export const ShipDataSchema = z
  .object({
    ...Common,
    kind: z.literal('ship'),
    team: TeamSchema,
    vx: z.number(),
    vy: z.number(),
    hp: z.number().int().min(0).max(255),
    maxHp: z.number().int().min(1).max(255),
    thrust: z.boolean(),
    respawnIn: z.number().min(0),
    invulnerable: z.number().min(0),
    cooldown: z.number().min(0),
    effects: z
      .object({ shield: z.number().min(0), rapid: z.number().min(0), homing: z.number().min(0) })
      .readonly(),
    score: z.number().int().min(0),
    deaths: z.number().int().min(0),
  })
  .readonly()
export const BulletDataSchema = z
  .object({
    ...Common,
    kind: z.literal('bullet'),
    team: TeamSchema,
    homing: z.boolean(),
    ownerId: EntityIdSchema.nullable(),
    spawnSeq: SeqSchema.nullable(),
  })
  .readonly()
export const AsteroidDataSchema = z
  .object({
    ...Common,
    kind: z.literal('asteroid'),
    size: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    variant: z.number().int().min(0).max(255),
    homing: z.boolean(),
  })
  .readonly()
export const PickupDataSchema = z
  .object({ ...Common, kind: z.literal('pickup'), effect: EffectSchema, ttl: z.number().min(0) })
  .readonly()
export const EntityDataSchema = z.discriminatedUnion('kind', [
  ShipDataSchema,
  BulletDataSchema,
  AsteroidDataSchema,
  PickupDataSchema,
])
export type ShipData = z.infer<typeof ShipDataSchema>
export type BulletData = z.infer<typeof BulletDataSchema>
export type AsteroidData = z.infer<typeof AsteroidDataSchema>
export type PickupData = z.infer<typeof PickupDataSchema>
export type EntityData = z.infer<typeof EntityDataSchema>

// ---------- події гри (у знімку; і на шині world.events) ----------
const At = { x: z.number(), y: z.number() }
export const FiredEventSchema = z
  .object({ ...At, type: z.literal('fired'), team: TeamSchema, shipId: EntityIdSchema, homing: z.boolean() })
  .readonly()
export const HitEventSchema = z
  .object({
    ...At,
    type: z.literal('hit'),
    team: TeamSchema,
    shipId: EntityIdSchema.nullable(), // null — влучили в астероїд
    target: z.enum(['ship', 'asteroid']),
  })
  .readonly()
export const ExplodedEventSchema = z
  .object({
    ...At,
    type: z.literal('exploded'),
    team: TeamSchema,
    shipId: EntityIdSchema.nullable(),
    kind: z.enum(['ship', 'asteroid']),
    size: z.number().int().min(0).max(255),
  })
  .readonly()
export const PickupEventSchema = z
  .object({ ...At, type: z.literal('pickup'), shipId: EntityIdSchema, effect: EffectSchema })
  .readonly()
export const ScoreEventSchema = z
  .object({
    ...At,
    type: z.literal('score'),
    shipId: EntityIdSchema,
    delta: z.number().int().min(0).max(65535),
  })
  .readonly()
export const GameEventSchema = z.discriminatedUnion('type', [
  FiredEventSchema,
  HitEventSchema,
  ExplodedEventSchema,
  PickupEventSchema,
  ScoreEventSchema,
])

export const SnapshotSchema = z
  .object({
    type: z.literal('snapshot'),
    tick: TickSchema,
    ack: SeqSchema,
    you: EntityIdSchema.nullable(),
    entities: z.array(EntityDataSchema).readonly(),
    events: z.array(GameEventSchema).readonly(),
  })
  .readonly()
export type Snapshot = z.infer<typeof SnapshotSchema>

// ---------- решта повідомлень сервер → клієнт ----------
export const PlayerInfoSchema = z
  .object({ id: z.string(), name: z.string(), shipId: EntityIdSchema })
  .readonly()
export type PlayerInfo = z.infer<typeof PlayerInfoSchema>

export const RoomInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    arena: z.string(),
    players: z.number().int().min(0),
    maxPlayers: z.number().int().min(1),
  })
  .readonly()
export type RoomInfo = z.infer<typeof RoomInfoSchema>
export const RoomsResponseSchema = z.object({ rooms: z.array(RoomInfoSchema) })

const NetConfigSchema = z.object({ lag: z.number(), jitter: z.number(), drop: z.number() })

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    v: z.number(),
    you: PlayerInfoSchema,
    room: RoomInfoSchema,
    tickRate: z.number().positive(),
    codec: z.enum(['json', 'binary']),
    net: NetConfigSchema,
    // Lab 8: id запуску сервера — новий після кожного перезапуску. Клієнт так відрізняє
    // «обірвалась мережа» (той самий bootId → граємо далі) від «сервер перезапустився» (→ лобі)
    bootId: z.string(),
  }),
  z.object({ type: z.literal('roster'), players: z.array(PlayerInfoSchema) }),
  z.object({ type: z.literal('chat'), from: PlayerInfoSchema, text: z.string(), t: z.number() }),
  z.object({ type: z.literal('system'), text: z.string() }),
  z.object({ type: z.literal('pong'), t: z.number(), tick: z.number() }),
  NetConfigSchema.extend({ type: z.literal('netsim') }),
  // Lab 8: сервер вимикається (SIGTERM, новий деплой) — попереджає ПЕРЕД закриттям з кодом 1001
  z.object({ type: z.literal('shutdown'), reason: z.string(), retryAfterMs: z.number().nonnegative() }),
  SnapshotSchema,
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>
export type ServerMessageType = ServerMessage['type']

// ---------- розбір: ніколи не кидає виняток на поганих даних ----------
export interface ProtocolError {
  readonly code: CloseCode
  readonly reason: string
}

// Record<тип, true>: якщо додати повідомлення в ClientMessageSchema і забути тут — помилка компіляції
const KNOWN_CLIENT_TYPES: Readonly<Record<ClientMessage['type'], true>> = {
  join: true,
  chat: true,
  leave: true,
  input: true,
  ping: true,
  netsim: true,
}

// Повідомлення від клієнта: розмір → JSON → форма → тип → версія → поля.
// Кожна помилка має свій код закриття (як у Lab 4) — щоб у логах було видно, ЩО не так.
export function parseClientMessage(text: string): Result<ClientMessage, ProtocolError> {
  const size = new TextEncoder().encode(text).byteLength
  if (size > MAX_MESSAGE_BYTES) return err({ code: CLOSE.TOO_BIG, reason: `message too big (${size} B)` })

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return err({ code: CLOSE.BAD_JSON, reason: 'not JSON' })
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data) || !('type' in data)) {
    return err({ code: CLOSE.BAD_SHAPE, reason: 'expected an object with a "type"' })
  }
  const type = data.type
  if (typeof type !== 'string') return err({ code: CLOSE.BAD_SHAPE, reason: '"type" must be a string' })
  if (!Object.hasOwn(KNOWN_CLIENT_TYPES, type))
    return err({ code: CLOSE.UNKNOWN_TYPE, reason: `unknown type "${type}"` })
  if (type === 'join' && 'v' in data && data.v !== PROTOCOL_VERSION) {
    return err({
      code: CLOSE.BAD_VERSION,
      reason: `protocol v${String(data.v)}, server speaks v${PROTOCOL_VERSION}`,
    })
  }
  const parsed = ClientMessageSchema.safeParse(data)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return err({
      code: CLOSE.BAD_SHAPE,
      reason: `bad "${type}": ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
    })
  }
  return ok(parsed.data)
}

// Повідомлення від сервера (на клієнті): сервер нам не ворог, але й падати від кривого рядка не будемо
export function parseServerMessage(text: string): Result<ServerMessage, string> {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return err('not JSON')
  }
  const parsed = ServerMessageSchema.safeParse(data)
  return parsed.success ? ok(parsed.data) : err(parsed.error.issues[0]?.message ?? 'invalid message')
}
