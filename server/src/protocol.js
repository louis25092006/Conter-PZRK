// Протокол v0: JSON-повідомлення через WebSocket. Кожне має поле `type`.
// Сервер НІКОЛИ не довіряє клієнту: кожне вхідне повідомлення проходить validate().
// У Lab 6 цей файл стане typed discriminated union, у Lab 5 — бінарним.

export const PROTOCOL_VERSION = 0
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
const clientMessages = {
  join: (m) => m.v === PROTOCOL_VERSION && isStr(m.roomId, 1, 64) && isStr(m.name, 1, MAX_NAME),
  chat: (m) => isStr(m.text, 1, MAX_CHAT),
  leave: () => true,
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
  welcome: (player, room) => ({ type: 'welcome', v: PROTOCOL_VERSION, you: player, room }),
  roster: (players) => ({ type: 'roster', players }),
  chat: (from, text, t) => ({ type: 'chat', from, text, t }),
  system: (text) => ({ type: 'system', text }),
}
