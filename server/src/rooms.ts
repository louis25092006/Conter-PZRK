import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { PlayerInfo, RoomInfo } from '@conter/shared/protocol.ts'
import type { Match } from './match.ts'

export type ArenaId = 'classic' | 'training' | 'dogfight'
export const ARENAS: readonly ArenaId[] = ['classic', 'training', 'dogfight']
export const isArenaId = (s: unknown): s is ArenaId => typeof s === 'string' && ARENAS.some((a) => a === s)

// Запис у лог матчу: що сталося в кімнаті
export type RoomLogEvent =
  | {
      readonly t: number
      readonly room: string
      readonly type: 'join' | 'leave'
      readonly player: PlayerInfo
    }
  | {
      readonly t: number
      readonly room: string
      readonly type: 'chat'
      readonly player: PlayerInfo
      readonly text: string
    }
  | { readonly t: number; readonly room: string; readonly type: 'close' }

// Lab 6: ТИПІЗОВАНИЙ EventEmitter — карта "подія → аргументи".
// room.on('chat', (player, text) => …) — компілятор знає, що text: string,
// а room.emit('chat', 42) — помилка компіляції.
export interface RoomEvents {
  join: [player: PlayerInfo]
  leave: [player: PlayerInfo]
  chat: [player: PlayerInfo, text: string]
  empty: []
  close: []
  event: [entry: RoomLogEvent]
}

export interface RoomInit {
  id?: string
  name: string
  arena?: ArenaId
  maxPlayers?: number
  persistent?: boolean
}

// Кімната — EventEmitter. Вона нічого не знає про WebSocket чи диск:
// лише тримає гравців і оголошує, що сталося.
export class Room extends EventEmitter<RoomEvents> {
  readonly id: string
  readonly name: string
  readonly arena: ArenaId
  readonly maxPlayers: number
  readonly persistent: boolean // стандартні кімнати не видаляються, коли спорожніють
  readonly players = new Map<string, PlayerInfo>()
  readonly createdAt = Date.now()
  closed = false
  eventCount = 0
  match: Match | null = null // авторитетна симуляція (Lab 5), живе, поки в кімнаті є гравці

  constructor({
    id = randomUUID().slice(0, 8),
    name,
    arena = 'classic',
    maxPlayers = 8,
    persistent = false,
  }: RoomInit) {
    super()
    this.id = id
    this.name = name
    this.arena = arena
    this.maxPlayers = maxPlayers
    this.persistent = persistent
  }

  get isFull(): boolean {
    return this.players.size >= this.maxPlayers
  }

  join(player: PlayerInfo): void {
    if (this.closed) throw new Error('room is closed')
    if (this.isFull) throw new Error('room is full')
    this.players.set(player.id, player)
    this.emit('join', player)
    this.#record({ t: Date.now(), room: this.id, type: 'join', player })
  }

  leave(playerId: string): void {
    const player = this.players.get(playerId)
    if (!player) return
    this.players.delete(playerId)
    this.emit('leave', player)
    this.#record({ t: Date.now(), room: this.id, type: 'leave', player })
    if (this.players.size === 0) this.emit('empty')
  }

  chat(playerId: string, text: string): void {
    const player = this.players.get(playerId)
    if (!player) return
    this.emit('chat', player, text)
    this.#record({ t: Date.now(), room: this.id, type: 'chat', player, text })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.eventCount > 0) this.#record({ t: Date.now(), room: this.id, type: 'close' }) // порожню кімнату не логуємо
    this.emit('close')
    this.removeAllListeners()
  }

  #record(entry: RoomLogEvent): void {
    this.eventCount++
    this.emit('event', entry)
  }

  toJSON(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      arena: this.arena,
      players: this.players.size,
      maxPlayers: this.maxPlayers,
    }
  }
}

export class RoomsLimitError extends Error {
  override name = 'RoomsLimitError'
}

export interface RoomManagerEvents {
  created: [room: Room]
  deleted: [room: Room]
}

// Менеджер кімнат: створює, знаходить, видаляє порожні.
export class RoomManager extends EventEmitter<RoomManagerEvents> {
  #rooms = new Map<string, Room>()
  readonly maxRooms: number
  readonly maxPlayersPerRoom: number

  constructor({
    maxRooms = 20,
    maxPlayersPerRoom = 8,
  }: { maxRooms?: number; maxPlayersPerRoom?: number } = {}) {
    super()
    this.maxRooms = maxRooms
    this.maxPlayersPerRoom = maxPlayersPerRoom
  }

  create({ maxPlayers = this.maxPlayersPerRoom, ...init }: RoomInit): Room {
    if (this.#rooms.size >= this.maxRooms)
      throw new RoomsLimitError(`server already has ${this.maxRooms} rooms`)
    const room = new Room({ ...init, maxPlayers: Math.min(maxPlayers, this.maxPlayersPerRoom) })
    this.#rooms.set(room.id, room)
    // кімната сама скаже, що спорожніла, — тоді прибираємо (крім стандартних)
    room.on('empty', () => {
      if (!room.persistent) this.delete(room.id)
    })
    this.emit('created', room)
    return room
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id)
  }

  *rooms(): Generator<Room> {
    yield* this.#rooms.values()
  }

  delete(id: string): boolean {
    const room = this.#rooms.get(id)
    if (!room) return false
    this.#rooms.delete(id)
    room.close()
    this.emit('deleted', room)
    return true
  }

  list(): RoomInfo[] {
    return [...this.#rooms.values()].map((r) => r.toJSON())
  }

  get size(): number {
    return this.#rooms.size
  }

  get playerCount(): number {
    let n = 0
    for (const room of this.#rooms.values()) n += room.players.size
    return n
  }

  closeAll(): void {
    for (const id of [...this.#rooms.keys()]) this.delete(id)
  }
}
