import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { validate, server as msg, CLOSE } from './protocol.js'
import { createTokenBucket } from './rate-limit.js'

// Життєвий цикл одного WebSocket-з'єднання:
//   connection → (≤ joinTimeoutMs) join → chat/leave… → close
// Стан з'єднання тримаємо в WeakMap: socket → { id, player, room, ... }.
// WeakMap сам "забуде" запис, коли сокет зникне.

// ---------- надсилання з політикою "повільного клієнта" ----------
// bufferedAmount — скільки байтів ми вже віддали сокету, але мережа ще не забрала.
// Якщо клієнт не встигає (поганий інтернет / завис), черга росте в пам'яті СЕРВЕРА.
// Некритичні повідомлення (чат) такому клієнту пропускаємо, а якщо зовсім погано — відключаємо.
// Повертає 'sent' | 'dropped' | 'closed' | 'skipped'.
export function createSender({ slowClientBytes, counters }) {
  return function send(socket, message, { critical = true } = {}) {
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
    socket.send(JSON.stringify(message))
    return 'sent'
  }
}

export function attachWebSockets({ wss, manager, config, log, counters }) {
  const state = new WeakMap()
  const send = createSender({ slowClientBytes: config.slowClientBytes, counters })

  function broadcast(room, message, options) {
    for (const client of wss.clients) {
      if (state.get(client)?.room === room) send(client, message, options)
    }
  }

  const roster = (room) => msg.roster([...room.players.values()])

  // ---------- підписка на події кімнати (один раз на кімнату) ----------
  const wired = new WeakSet()
  function wire(room) {
    if (wired.has(room)) return
    wired.add(room)
    room.on('join', () => broadcast(room, roster(room)))
    room.on('leave', (player) => {
      broadcast(room, roster(room))
      broadcast(room, msg.system(`${player.name} вийшов`), { critical: false })
    })
    room.on('chat', (player, text) =>
      broadcast(room, msg.chat(player, text, Date.now()), { critical: false }),
    )
  }

  function reject(socket, code, reason) {
    counters.rejected++
    log.warn('closing socket', { code, reason, id: state.get(socket)?.id })
    socket.close(code, reason.slice(0, 120)) // reason у кадрі close — до 123 байт
  }

  // ---------- обробники повідомлень ----------
  const handlers = {
    join(socket, s, m) {
      if (s.room) return reject(socket, CLOSE.BAD_SHAPE, 'already joined')
      const room = manager.get(m.roomId)
      if (!room || room.closed) return reject(socket, CLOSE.ROOM_UNAVAILABLE, 'no such room')
      if (room.isFull) return reject(socket, CLOSE.ROOM_UNAVAILABLE, 'room is full')
      clearTimeout(s.joinTimer)
      s.player = { id: s.id, name: m.name.trim() }
      s.room = room
      wire(room)
      send(socket, msg.welcome(s.player, room.toJSON()))
      room.join(s.player) // → 'join' → roster усім у кімнаті
      log.info('player joined', { room: room.id, player: s.player.name, online: room.players.size })
    },
    chat(socket, s, m) {
      s.room.chat(s.id, m.text.trim())
    },
    leave(socket) {
      socket.close(CLOSE.NORMAL, 'bye')
    },
  }

  // ---------- нове з'єднання ----------
  wss.on('connection', (socket, req) => {
    const s = {
      id: randomUUID().slice(0, 8),
      player: null,
      room: null,
      missedPongs: 0,
      bucket: createTokenBucket({ perSec: config.rateLimitPerSec, burst: config.rateLimitBurst }),
      joinTimer: null,
    }
    state.set(socket, s)
    counters.connections++

    // 'error' БЕЗ слухача = падіння всього процесу (EventEmitter кидає помилку).
    // Тому слухач є на КОЖНОМУ сокеті, навіть якщо ми лише логуємо.
    socket.on('error', (err) => log.warn('socket error', { id: s.id, error: err.message }))

    // хто не представився за joinTimeoutMs — до побачення
    s.joinTimer = setTimeout(() => reject(socket, CLOSE.JOIN_TIMEOUT, 'join timeout'), config.joinTimeoutMs)

    socket.on('pong', () => {
      s.missedPongs = 0
    })

    socket.on('message', (data, isBinary) => {
      if (!s.bucket.take()) return reject(socket, CLOSE.RATE_LIMIT, 'rate limit')
      if (isBinary) return reject(socket, CLOSE.BAD_SHAPE, 'binary not supported in protocol v0')
      const result = validate(data.toString('utf8'))
      if (!result.ok) return reject(socket, result.code, result.reason)
      const m = result.msg
      if (m.type !== 'join' && !s.room) return reject(socket, CLOSE.NOT_JOINED, 'join first')
      counters.messages++
      handlers[m.type](socket, s, m)
    })

    socket.on('close', (code) => {
      clearTimeout(s.joinTimer)
      if (s.room) {
        log.info('player left', { room: s.room.id, player: s.player.name, code })
        s.room.leave(s.id)
      }
      s.room = null
    })

    log.info('socket connected', { id: s.id, ip: req.socket.remoteAddress })
  })

  // ---------- heartbeat ----------
  // Мертве з'єднання (вимкнений Wi-Fi) може не надіслати close взагалі.
  // Тому кожні heartbeatMs шлемо ping; хто пропустив 2 pong поспіль — розриваємо.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const s = state.get(socket)
      if (!s) continue
      if (s.missedPongs >= 2) {
        counters.terminated++
        log.warn('no pong, terminating', { id: s.id })
        socket.terminate()
        continue
      }
      s.missedPongs++
      socket.ping()
    }
  }, config.heartbeatMs)
  heartbeat.unref() // таймер не тримає процес живим сам по собі

  return {
    stop() {
      clearInterval(heartbeat)
    },
  }
}
