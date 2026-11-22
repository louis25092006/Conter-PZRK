import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

export const ARENAS = ['classic', 'training', 'dogfight']

// Кімната — EventEmitter. Вона нічого не знає про WebSocket чи диск:
// лише тримає гравців і оголошує, що сталося.
//   'join' (player)  'leave' (player)  'chat' (player, text)  'empty'  'close'
//   'event' ({ t, type, ... })  — усе вищеперелічене у вигляді даних для логу матчу
export class Room extends EventEmitter {
  constructor({
    id = randomUUID().slice(0, 8),
    name,
    arena = 'classic',
    maxPlayers = 8,
    persistent = false,
  }) {
    super()
    this.id = id
    this.name = name
    this.arena = arena
    this.maxPlayers = maxPlayers
    this.persistent = persistent // стандартні кімнати не видаляються, коли спорожніють
    this.players = new Map() // id -> { id, name }
    this.createdAt = Date.now()
    this.closed = false
    this.eventCount = 0
  }

  get isFull() {
    return this.players.size >= this.maxPlayers
  }

  #record(type, data) {
    this.eventCount++
    this.emit('event', { t: Date.now(), room: this.id, type, ...data })
  }

  join(player) {
    if (this.closed) throw new Error('room is closed')
    if (this.isFull) throw new Error('room is full')
    this.players.set(player.id, player)
    this.emit('join', player)
    this.#record('join', { player })
  }

  leave(playerId) {
    const player = this.players.get(playerId)
    if (!player) return
    this.players.delete(playerId)
    this.emit('leave', player)
    this.#record('leave', { player })
    if (this.players.size === 0) this.emit('empty')
  }

  chat(playerId, text) {
    const player = this.players.get(playerId)
    if (!player) return
    this.emit('chat', player, text)
    this.#record('chat', { player, text })
  }

  close() {
    if (this.closed) return
    this.closed = true
    if (this.eventCount > 0) this.#record('close', {}) // порожню кімнату не логуємо
    this.emit('close')
    this.removeAllListeners()
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      arena: this.arena,
      players: this.players.size,
      maxPlayers: this.maxPlayers,
    }
  }
}

// Менеджер кімнат: створює, знаходить, видаляє порожні.
// 'created' (room)  'deleted' (room)
export class RoomManager extends EventEmitter {
  #rooms = new Map()

  constructor({ maxRooms = 20, maxPlayersPerRoom = 8 } = {}) {
    super()
    this.maxRooms = maxRooms
    this.maxPlayersPerRoom = maxPlayersPerRoom
  }

  create({ name, arena = 'classic', maxPlayers = this.maxPlayersPerRoom, persistent = false, id }) {
    if (this.#rooms.size >= this.maxRooms) {
      const err = new Error(`server already has ${this.maxRooms} rooms`)
      err.code = 'ROOMS_LIMIT'
      throw err
    }
    const room = new Room({
      id,
      name,
      arena,
      maxPlayers: Math.min(maxPlayers, this.maxPlayersPerRoom),
      persistent,
    })
    this.#rooms.set(room.id, room)
    // кімната сама скаже, що спорожніла, — тоді прибираємо (крім стандартних)
    room.on('empty', () => {
      if (!room.persistent) this.delete(room.id)
    })
    this.emit('created', room)
    return room
  }

  get(id) {
    return this.#rooms.get(id)
  }

  *rooms() {
    yield* this.#rooms.values()
  }

  delete(id) {
    const room = this.#rooms.get(id)
    if (!room) return false
    this.#rooms.delete(id)
    room.close()
    this.emit('deleted', room)
    return true
  }

  list() {
    return [...this.#rooms.values()].map((r) => r.toJSON())
  }

  get size() {
    return this.#rooms.size
  }

  get playerCount() {
    let n = 0
    for (const room of this.#rooms.values()) n += room.players.size
    return n
  }

  closeAll() {
    for (const id of [...this.#rooms.keys()]) this.delete(id)
  }
}
