import { encodeInput, decodeInput, encodeSnapshot, decodeSnapshot } from './binary.js'

// Два кодеки з однаковим інтерфейсом — щоб порівняти JSON і бінарний формат (README, M4).
// encode* повертає рядок (JSON, текстовий кадр WebSocket) або ArrayBuffer (бінарний кадр).

export const jsonCodec = {
  name: 'json',
  encodeInput: (input) => JSON.stringify({ type: 'input', ...input }),
  decodeInput: (text) => JSON.parse(text),
  encodeSnapshot: (snap) => JSON.stringify(snap),
  decodeSnapshot: (text) => JSON.parse(text),
}

export const binaryCodec = {
  name: 'binary',
  encodeInput,
  decodeInput,
  encodeSnapshot: (snap) => encodeSnapshot(snap),
  decodeSnapshot,
}

export const codecs = { json: jsonCodec, binary: binaryCodec }

export function byteSize(encoded) {
  return typeof encoded === 'string' ? new TextEncoder().encode(encoded).byteLength : encoded.byteLength
}
