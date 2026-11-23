import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { startHeartbeat } from './heartbeat.ts'
import * as binary from '@conter/shared/codec/binary.ts'

const BOT_PREFIX = 'bot-'
const isBotId = (id: string): boolean => id.startsWith(BOT_PREFIX)
export class RoomUnavailableError extends Error {
  override name = 'RoomUnavailableError'
}
import { WebSocket, type RawData, type WebSocketServer } from 'ws'
import {
  parseClientMessage,
  CLOSE,
  PROTOCOL_VERSION,
  type ClientMessage,
  type CloseCode,
  type InputMsg,
  type PlayerInfo,
} from '@conter/shared/protocol.ts'
import { codecs, byteSize, type Codec } from '@conter/shared/codec/index.ts'
import { makeSnapshot } from '@conter/shared/net/snapshot.ts'
import { assertNever, type EntityId } from '@conter/shared/types.ts'
import type { Arenas } from '@conter/shared/arena-config.ts'
import { createTokenBucket, type TokenBucket } from './rate-limit.ts'
import { Match } from './match.ts'
import { createLink, parseNetParams, type Link } from './netsim.ts'
import type { Room, RoomManager } from './rooms.ts'
import type { ServerConfig } from './config.ts'
import type { Logger } from './logger.ts'

// Життєвий цикл одного WebSocket-з'єднання:
//   connection → (≤ joinTimeoutMs) join → input/chat/ping… → close

export interface Counters {
  connections: number
  messages: number
  rejected: number
  dropped: number
  slowClosed: number
  terminated: number
}

interface SocketState {
  readonly id: string
  player: PlayerInfo | null
  room: Room | null
  shipId: EntityId | null
  readonly codec: Codec
  readonly link: Link
  bytesOut: number
  bytesIn: number
  missedPongs: number
  readonly inputBucket: TokenBucket // команди йдуть 60/с
  readonly otherBucket: TokenBucket // а чат і т.п. — рідко
  joinTimer: ReturnType<typeof setTimeout> | null
}

export type Outgoing = string | ArrayBuffer | Readonly<Record<string, unknown>>
export type SendResult = 'sent' | 'dropped' | 'closed' | 'skipped'

// Що з сокета потрібно політиці повільного клієнта (у тестах — підробка, без справжнього сокета)
export interface SendTarget {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string | ArrayBuffer): void
  close(code: number, reason: string): void
}

// ---------- надсилання з політикою "повільного клієнта" ----------
export function createSender({
  slowClientBytes,
  counters,
}: {
  slowClientBytes: number
  counters: Pick<Counters, 'dropped' | 'slowClosed'>
}) {
  return function send(socket: SendTarget, message: Outgoing, { critical = true } = {}): SendResult {
    if (socket.readyState !== WebSocket.OPEN) return 'skipped'
    if (socket.bufferedAmount > slowClientBytes * 4) {
      counters.slowClosed++
      socket.close(CLOSE.SLOW_CLIENT, 'too slow')
      return 'closed'
    }
    if (!critical && socket.bufferedAmount > slowClientBytes) {
      counters.dropped++
      return 'dropped'
    }
    socket.send(
      typeof message === 'string' || message instanceof ArrayBuffer ? message : JSON.stringify(message),
    )
    return 'sent'
  }
}

// RawData з ws — Buffer | ArrayBuffer | Buffer[] (фрагменти); зводимо до одного Buffer
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

export interface WsDeps {
  wss: WebSocketServer
  manager: RoomManager
  config: ServerConfig
  log: Logger
  counters: Counters
  arenas: Arenas
}

export function attachWebSockets({ wss, manager, config, log, counters, arenas }: WsDeps) {
  const state = new WeakMap<WebSocket, SocketState>()
  const send = createSender({ slowClientBytes: config.slowClientBytes, counters })

  function deliver(
    socket: WebSocket,
    message: Outgoing,
    options: { critical?: boolean; droppable?: boolean } = {},
  ): void {
    const go = (): void => void send(socket, message, options)
    const s = state.get(socket)
    if (s) s.link.out(go, { droppable: options.droppable ?? false })
    else go()
  }

  function clientsIn(room: Room): WebSocket[] {
    const list: WebSocket[] = []
    for (const client of wss.clients) if (state.get(client)?.room === room) list.push(client)
    return list
  }

  function broadcast(room: Room, message: Outgoing, options?: { critical?: boolean }): void {
    for (const client of clientsIn(room)) deliver(client, message, options)
  }

  const roster = (room: Room) => ({ type: 'roster', players: [...room.players.values()] })

  // ---------- матч кімнати: стартує з першим гравцем, зупиняється з останнім ----------
  function ensureMatch(room: Room): Match {
    if (room.match) return room.match
    const arena = arenas[room.arena] ?? Object.values(arenas)[0]
    if (!arena) throw new Error('no arenas configured')
    const match = new Match({ arena })
    match.onSnapshot = ({ tick, entities, events }) => {
      // сутності спільні, а ack і you — свої для кожного клієнта.
      // Lab 7: бінарне тіло кодуємо один раз на тік, клієнтам — копія з власним заголовком.
      let binaryTemplate: ArrayBuffer | null = null
      for (const client of clientsIn(room)) {
        const s = state.get(client)
        if (!s) continue
        const ack = match.ackFor(s.id)
        let encoded: string | ArrayBuffer
        if (s.codec.name === 'binary') {
          binaryTemplate ??= binary.encodeSnapshot(makeSnapshot({ tick, ack, you: null, entities, events }))
          encoded = binary.withSnapshotHeader(binaryTemplate, ack, s.shipId)
        } else {
          encoded = s.codec.encodeSnapshot(makeSnapshot({ tick, ack, you: s.shipId, entities, events }))
        }
        s.bytesOut += byteSize(encoded)
        deliver(client, encoded, { critical: false, droppable: true })
      }
    }
    room.match = match
    match.start()
    log.info('match started', { room: room.id, arena: room.arena })
    return match
  }

  // ---------- підписка на події кімнати (один раз на кімнату) ----------
  const wired = new WeakSet<Room>()
  function wire(room: Room): void {
    if (wired.has(room)) return
    wired.add(room)
    room.on('join', () => broadcast(room, roster(room)))
    room.on('leave', (player) => {
      broadcast(room, roster(room))
      broadcast(room, { type: 'system', text: `${player.name} вийшов` }, { critical: false })
    })
    room.on('chat', (player, text) =>
      broadcast(room, { type: 'chat', from: player, text, t: Date.now() }, { critical: false }),
    )
    room.on('close', () => room.match?.stop())
  }

  function reject(socket: WebSocket, code: CloseCode, reason: string): void {
    counters.rejected++
    log.warn('closing socket', { code, reason, id: state.get(socket)?.id })
    socket.close(code, reason.slice(0, 120)) // reason у кадрі close — до 123 байт
  }

  function acceptInput(socket: WebSocket, s: SocketState, cmd: InputMsg): void {
    if (!s.room) return reject(socket, CLOSE.NOT_JOINED, 'join first')
    if (!s.inputBucket.take()) return reject(socket, CLOSE.RATE_LIMIT, 'input rate limit')
    s.room.match?.pushInput(s.id, cmd)
  }

  function join(socket: WebSocket, s: SocketState, roomId: string, name: string): void {
    if (s.room) return reject(socket, CLOSE.BAD_SHAPE, 'already joined')
    const room = manager.get(roomId)
    if (!room || room.closed) return reject(socket, CLOSE.ROOM_UNAVAILABLE, 'no such room')
    if (room.isFull) return reject(socket, CLOSE.ROOM_UNAVAILABLE, 'room is full')
    if (s.joinTimer) clearTimeout(s.joinTimer)
    const match = ensureMatch(room)
    const shipId = match.addPlayer(s.id)
    const player: PlayerInfo = { id: s.id, name, shipId }
    s.shipId = shipId
    s.player = player
    s.room = room
    wire(room)
    deliver(socket, {
      type: 'welcome',
      v: PROTOCOL_VERSION,
      you: player,
      room: room.toJSON(),
      tickRate: match.tickRate,
      codec: s.codec.name,
      net: { ...s.link.config },
    })
    room.join(player) // → 'join' → roster усім у кімнаті
    log.info('player joined', { room: room.id, player: name, ship: shipId, codec: s.codec.name })
  }

  // Кожен варіант ClientMessage обробляється тут; default з never — якщо в протокол додадуть
  // нове повідомлення і забудуть обробити, проєкт просто не скомпілюється.
  function handle(socket: WebSocket, s: SocketState, m: ClientMessage): void {
    if (m.type !== 'join' && m.type !== 'ping' && !s.room)
      return reject(socket, CLOSE.NOT_JOINED, 'join first')
    if (m.type !== 'input' && !s.otherBucket.take()) return reject(socket, CLOSE.RATE_LIMIT, 'rate limit')
    counters.messages++
    switch (m.type) {
      case 'join':
        return join(socket, s, m.roomId, m.name)
      case 'chat':
        return s.room?.chat(s.id, m.text)
      case 'leave':
        return socket.close(CLOSE.NORMAL, 'bye')
      case 'input':
        return acceptInput(socket, s, m)
      case 'ping': // RTT: повертаємо час клієнта (через той самий імітатор мережі)
        return deliver(socket, { type: 'pong', t: m.t, tick: s.room?.match?.tick ?? 0 })
      case 'netsim': // змінити імітацію мережі "на льоту" з панелі нетграфа
        s.link.set(m)
        return deliver(socket, { type: 'netsim', ...s.link.config })
      default:
        return assertNever(m, 'client message')
    }
  }

  function onMessage(socket: WebSocket, s: SocketState, data: RawData, isBinary: boolean): void {
    const bytes = toBuffer(data)
    s.bytesIn += bytes.length
    // вхідні теж проходять через імітатор затримки (порядок зберігається)
    s.link.in(() => {
      if (socket.readyState !== WebSocket.OPEN) return
      if (isBinary) {
        // бінарне повідомлення = команда гравця (INPUT, 8 байтів), декодер перевіряє все сам
        const result = codecs.binary.decodeInput(bytes)
        if (!result.ok) return reject(socket, CLOSE.BAD_SHAPE, `bad binary input: ${result.error}`)
        return acceptInput(socket, s, result.value)
      }
      const parsed = parseClientMessage(bytes.toString('utf8'))
      if (!parsed.ok) return reject(socket, parsed.error.code, parsed.error.reason)
      handle(socket, s, parsed.value)
    })
  }

  // ---------- нове з'єднання ----------
  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const net = parseNetParams(req.url ?? '/')
    const s: SocketState = {
      id: randomUUID().slice(0, 8),
      player: null,
      room: null,
      shipId: null,
      codec: codecs[net.codec],
      link: createLink(net),
      bytesOut: 0,
      bytesIn: 0,
      missedPongs: 0,
      inputBucket: createTokenBucket({ perSec: 90, burst: 150 }),
      otherBucket: createTokenBucket({ perSec: config.rateLimitPerSec, burst: config.rateLimitBurst }),
      joinTimer: null,
    }
    state.set(socket, s)
    counters.connections++

    // 'error' БЕЗ слухача = падіння всього процесу. Тому слухач є на КОЖНОМУ сокеті.
    socket.on('error', (e: Error) => log.warn('socket error', { id: s.id, error: e.message }))

    // хто не представився за joinTimeoutMs — до побачення
    s.joinTimer = setTimeout(() => reject(socket, CLOSE.JOIN_TIMEOUT, 'join timeout'), config.joinTimeoutMs)
    socket.on('pong', () => {
      s.missedPongs = 0
    })
    socket.on('message', (data, isBinary) => onMessage(socket, s, data, isBinary))

    socket.on('close', (code) => {
      if (s.joinTimer) clearTimeout(s.joinTimer)
      const room = s.room
      if (room && s.player) {
        log.info('player left', { room: room.id, player: s.player.name, code })
        room.match?.removePlayer(s.id)
        room.leave(s.id)
        // пішла остання людина — боти теж ідуть (літати самим собі немає сенсу, а CPU витрачається)
        if (![...room.players.keys()].some((id) => !isBotId(id))) {
          for (const id of [...room.players.keys()]) {
            room.match?.removePlayer(id)
            room.leave(id)
          }
        }
        if (room.players.size === 0 && room.match) {
          room.match.stop()
          room.match = null
          log.info('match stopped (room empty)', { room: room.id })
        }
      }
      s.room = null
    })

    log.info('socket connected', { id: s.id, ip: req.socket.remoteAddress, ...net })
  })

  // ---------- heartbeat ----------
  const heartbeat = startHeartbeat({
    intervalMs: config.heartbeatMs,
    clients: () => wss.clients,
    missed: (socket) => state.get(socket),
    onTerminate: (socket) => {
      counters.terminated++
      log.warn('no pong, terminating', { id: state.get(socket)?.id })
    },
  })

  // Lab 7, M4: додати N ботів у кімнату (POST /api/rooms/:id/bots). Боти — звичайні
  // гравці кімнати (є в ростері з іменем), лише команди літаку дає Bot на сервері.
  let botCounter = 0
  function addBots(roomId: string, count: number): PlayerInfo[] {
    const room = manager.get(roomId)
    if (!room || room.closed) throw new RoomUnavailableError('no such room')
    const added: PlayerInfo[] = []
    const match = ensureMatch(room)
    wire(room)
    for (let i = 0; i < count && !room.isFull; i++) {
      const id = `${BOT_PREFIX}${++botCounter}`
      const player: PlayerInfo = { id, name: `Bot ${botCounter}`, shipId: match.addBot(id) }
      room.join(player)
      added.push(player)
    }
    if (added.length) log.info('bots added', { room: room.id, count: added.length, bots: match.botCount })
    return added
  }

  return {
    addBots,
    stop(): void {
      heartbeat.stop()
      for (const room of manager.rooms()) room.match?.stop()
    },
    // для /api/stats
    stats() {
      const out = []
      for (const room of manager.rooms()) {
        if (!room.match) continue
        out.push({
          room: room.id,
          ...room.match.summary(),
          clients: clientsIn(room).map((c) => {
            const s = state.get(c)
            return {
              name: s?.player?.name,
              codec: s?.codec.name,
              net: s?.link.config,
              bytesOut: s?.bytesOut,
              bytesIn: s?.bytesIn,
            }
          }),
        })
      }
      return out
    },
  }
}
