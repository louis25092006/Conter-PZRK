import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { validate, isValidInput, server as msg, CLOSE } from './protocol.js'
import { createTokenBucket } from './rate-limit.js'
import { Match } from './match.js'
import { createLink, parseNetParams } from './netsim.js'
import { codecs, byteSize } from '@conter/shared/codec/index.js'
import { makeSnapshot } from '@conter/shared/net/snapshot.js'

// Життєвий цикл одного WebSocket-з'єднання:
//   connection → (≤ joinTimeoutMs) join → input/chat/ping… → close
// Стан з'єднання тримаємо в WeakMap: socket → { id, player, room, link, codec, ... }.
// WeakMap сам "забуде" запис, коли сокет зникне.

// ---------- надсилання з політикою "повільного клієнта" ----------
// bufferedAmount — скільки байтів ми вже віддали сокету, але мережа ще не забрала.
// Якщо клієнт не встигає (поганий інтернет / завис), черга росте в пам'яті СЕРВЕРА.
// Некритичні повідомлення (чат, знімки) такому клієнту пропускаємо, а якщо зовсім погано — відключаємо.
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
    // рядок або байти (знімок у бінарному форматі) — як є; об'єкт — у JSON
    const raw = typeof message === 'string' || message instanceof ArrayBuffer || ArrayBuffer.isView(message)
    socket.send(raw ? message : JSON.stringify(message))
    return 'sent'
  }
}

export function attachWebSockets({ wss, manager, config, log, counters, arenas }) {
  const state = new WeakMap()
  const send = createSender({ slowClientBytes: config.slowClientBytes, counters })

  // надіслати через імітатор мережі цього клієнта
  function deliver(socket, message, options = {}) {
    const s = state.get(socket)
    const go = () => send(socket, message, options)
    if (s?.link) s.link.out(go, { droppable: options.droppable })
    else go()
  }

  function clientsIn(room) {
    const list = []
    for (const client of wss.clients) if (state.get(client)?.room === room) list.push(client)
    return list
  }

  function broadcast(room, message, options) {
    for (const client of clientsIn(room)) deliver(client, message, options)
  }

  const roster = (room) => msg.roster([...room.players.values()])

  // ---------- матч кімнати: стартує з першим гравцем, зупиняється з останнім ----------
  function ensureMatch(room) {
    if (room.match) return room.match
    room.match = new Match({
      arena: arenas[room.arena] ?? Object.values(arenas)[0],
      onSnapshot: ({ tick, entities, events }) => {
        // сутності спільні, а ack і you — свої для кожного клієнта
        for (const client of clientsIn(room)) {
          const s = state.get(client)
          const snap = makeSnapshot({ tick, ack: room.match.ackFor(s.id), you: s.shipId, entities, events })
          const encoded = codecs[s.codec].encodeSnapshot(snap)
          s.bytesOut += byteSize(encoded)
          deliver(client, encoded, { critical: false, droppable: true })
        }
      },
    })
    room.match.start()
    log.info('match started', { room: room.id, arena: room.arena })
    return room.match
  }

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
    room.on('close', () => room.match?.stop())
  }

  function reject(socket, code, reason) {
    counters.rejected++
    log.warn('closing socket', { code, reason, id: state.get(socket)?.id })
    socket.close(code, reason.slice(0, 120)) // reason у кадрі close — до 123 байт
  }

  function acceptInput(socket, s, cmd) {
    if (!s.room) return reject(socket, CLOSE.NOT_JOINED, 'join first')
    if (!s.inputBucket.take()) return reject(socket, CLOSE.RATE_LIMIT, 'input rate limit')
    s.room.match?.pushInput(s.id, cmd)
  }

  // ---------- обробники JSON-повідомлень ----------
  const handlers = {
    join(socket, s, m) {
      if (s.room) return reject(socket, CLOSE.BAD_SHAPE, 'already joined')
      const room = manager.get(m.roomId)
      if (!room || room.closed) return reject(socket, CLOSE.ROOM_UNAVAILABLE, 'no such room')
      if (room.isFull) return reject(socket, CLOSE.ROOM_UNAVAILABLE, 'room is full')
      clearTimeout(s.joinTimer)
      const match = ensureMatch(room)
      s.shipId = match.addPlayer(s.id)
      s.player = { id: s.id, name: m.name.trim(), shipId: s.shipId }
      s.room = room
      wire(room)
      deliver(
        socket,
        msg.welcome(s.player, room.toJSON(), {
          tickRate: match.tickRate,
          codec: s.codec,
          net: { ...s.link.config },
        }),
      )
      room.join(s.player) // → 'join' → roster усім у кімнаті
      log.info('player joined', { room: room.id, player: s.player.name, ship: s.shipId, codec: s.codec })
    },
    chat(socket, s, m) {
      if (!s.otherBucket.take()) return reject(socket, CLOSE.RATE_LIMIT, 'rate limit')
      s.room.chat(s.id, m.text.trim())
    },
    leave(socket) {
      socket.close(CLOSE.NORMAL, 'bye')
    },
    input(socket, s, m) {
      acceptInput(socket, s, { seq: m.seq, turn: m.turn, thrust: m.thrust, fire: m.fire })
    },
    // RTT: клієнт шле свій час, ми одразу повертаємо (через той самий імітатор мережі)
    ping(socket, s, m) {
      deliver(socket, { type: 'pong', t: m.t, tick: s.room?.match?.tick ?? 0 })
    },
    // змінити імітацію мережі "на льоту" з панелі нетграфа
    netsim(socket, s, m) {
      s.link.set(m)
      deliver(socket, { type: 'netsim', ...s.link.config })
    },
  }

  // ---------- нове з'єднання ----------
  wss.on('connection', (socket, req) => {
    const net = parseNetParams(req.url)
    const s = {
      id: randomUUID().slice(0, 8),
      player: null,
      room: null,
      shipId: 0,
      codec: net.codec,
      link: createLink(net),
      bytesOut: 0,
      bytesIn: 0,
      missedPongs: 0,
      // два відра: команди йдуть 60/с, а чат — рідко
      inputBucket: createTokenBucket({ perSec: 90, burst: 150 }),
      otherBucket: createTokenBucket({ perSec: config.rateLimitPerSec, burst: config.rateLimitBurst }),
      joinTimer: null,
    }
    state.set(socket, s)
    counters.connections++
    if (s.codec === 'binary') socket.binaryType = 'nodebuffer'

    // 'error' БЕЗ слухача = падіння всього процесу (EventEmitter кидає помилку).
    // Тому слухач є на КОЖНОМУ сокеті, навіть якщо ми лише логуємо.
    socket.on('error', (err) => log.warn('socket error', { id: s.id, error: err.message }))

    // хто не представився за joinTimeoutMs — до побачення
    s.joinTimer = setTimeout(() => reject(socket, CLOSE.JOIN_TIMEOUT, 'join timeout'), config.joinTimeoutMs)

    socket.on('pong', () => {
      s.missedPongs = 0
    })

    socket.on('message', (data, isBinary) => {
      s.bytesIn += data.length
      // вхідні теж проходять через імітатор затримки (порядок зберігається)
      s.link.in(() => {
        if (socket.readyState !== WebSocket.OPEN) return
        if (isBinary) {
          // бінарне повідомлення = команда гравця (INPUT, 8 байтів)
          let cmd
          try {
            cmd = codecs.binary.decodeInput(data)
          } catch (err) {
            return reject(socket, CLOSE.BAD_SHAPE, `bad binary input: ${err.message}`)
          }
          if (!isValidInput(cmd)) return reject(socket, CLOSE.BAD_SHAPE, 'bad input values')
          return acceptInput(socket, s, cmd)
        }
        const result = validate(data.toString('utf8'))
        if (!result.ok) return reject(socket, result.code, result.reason)
        const m = result.msg
        if (m.type !== 'join' && m.type !== 'ping' && !s.room)
          return reject(socket, CLOSE.NOT_JOINED, 'join first')
        if (m.type !== 'input' && m.type !== 'chat' && !s.otherBucket.take()) {
          return reject(socket, CLOSE.RATE_LIMIT, 'rate limit')
        }
        counters.messages++
        handlers[m.type](socket, s, m)
      })
    })

    socket.on('close', (code) => {
      clearTimeout(s.joinTimer)
      if (s.room) {
        log.info('player left', { room: s.room.id, player: s.player.name, code })
        const room = s.room
        room.match?.removePlayer(s.id)
        room.leave(s.id)
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
              name: s.player?.name,
              codec: s.codec,
              net: s.link.config,
              bytesOut: s.bytesOut,
              bytesIn: s.bytesIn,
            }
          }),
        })
      }
      return out
    },
  }
}
