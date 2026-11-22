// Протокол v1 (Lab 5). Рідкісні повідомлення — JSON-текст з полем `type` (тут).
// Часті — команди гравця і знімки світу — бінарні кадри (shared/src/codec/binary.js),
// або JSON, якщо клієнт підключився з ?codec=json (для порівняння розмірів).
// Сервер НІКОЛИ не довіряє клієнту: кожне вхідне повідомлення проходить перевірку.
// v0 (Lab 4): join/chat/leave. v1: + input, ping, netsim; roster містить shipId.

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

const isStr = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.length <= max

// Схеми повідомлень від клієнта: тип -> перевірка полів
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

// Команда гравця: лише -1/0/1 і true/false. turn: 1000 або thrust: "yes" — це чит → закриваємо.
export function isValidInput(m) {
  return (
    Number.isInteger(m.seq) &&
    m.seq >= 1 &&
    m.seq <= 0xffffffff &&
    [-1, 0, 1].includes(m.turn) &&
    typeof m.thrust === 'boolean' &&
    typeof m.fire === 'boolean'
  )
}

const clientMessages = {
  join: (m) => m.v === PROTOCOL_VERSION && isStr(m.roomId, 1, 64) && isStr(m.name, 1, MAX_NAME),
  chat: (m) => isStr(m.text, 1, MAX_CHAT),
  leave: () => true,
  input: isValidInput, // JSON-варіант команди (?codec=json)
  ping: (m) => isNum(m.t, 0, Number.MAX_SAFE_INTEGER),
  netsim: (m) => isNum(m.lag, 0, 1000) && isNum(m.jitter, 0, 500) && isNum(m.drop, 0, 0.5),
}

// Повертає { ok: true, msg } або { ok: false, code, reason }
export function validate(raw) {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length
  if (size > MAX_MESSAGE_BYTES)
    return { ok: false, code: CLOSE.TOO_BIG, reason: `message too big (${size} B)` }

  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return { ok: false, code: CLOSE.BAD_JSON, reason: 'not JSON' }
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
    return { ok: false, code: CLOSE.BAD_SHAPE, reason: 'expected an object with a "type"' }
  }
  const check = Object.hasOwn(clientMessages, msg.type) ? clientMessages[msg.type] : null
  if (!check) return { ok: false, code: CLOSE.UNKNOWN_TYPE, reason: `unknown type "${msg.type}"` }
  if (msg.type === 'join' && msg.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: CLOSE.BAD_VERSION,
      reason: `protocol v${msg.v}, server speaks v${PROTOCOL_VERSION}`,
    }
  }
  if (!check(msg)) return { ok: false, code: CLOSE.BAD_SHAPE, reason: `bad "${msg.type}" message` }
  return { ok: true, msg }
}

// Повідомлення сервер -> клієнт (конструктори, щоб форма була в одному місці)
export const server = {
  welcome: (player, room, extra = {}) => ({
    type: 'welcome',
    v: PROTOCOL_VERSION,
    you: player,
    room,
    ...extra,
  }),
  roster: (players) => ({ type: 'roster', players }),
  chat: (from, text, t) => ({ type: 'chat', from, text, t }),
  system: (text) => ({ type: 'system', text }),
}
