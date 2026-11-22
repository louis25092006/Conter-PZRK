import { encodeInput, decodeInput, encodeSnapshot, decodeSnapshot } from './binary.ts'
import {
  ClientMessageSchema,
  InputMessage,
  SnapshotSchema,
  type InputMsg,
  type Snapshot,
} from '../protocol.ts'
import { err, errorMessage, ok, type Result } from '../types.ts'

// Codec — інтерфейс, дві реалізації (JSON для порівняння, бінарний DataView для гри).
// Сервер і клієнт працюють з Codec, не знаючи, який саме всередині.
export type Encoded = string | ArrayBuffer
export type Incoming = string | ArrayBuffer | ArrayBufferView

export interface Codec {
  readonly name: 'json' | 'binary'
  encodeInput(input: InputMsg): Encoded
  decodeInput(data: Incoming): Result<InputMsg, string>
  encodeSnapshot(snapshot: Snapshot): Encoded
  decodeSnapshot(data: Incoming): Result<Snapshot, string>
}

function decodeText(d: Incoming): string {
  if (typeof d === 'string') return d
  const bytes =
    d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
  return new TextDecoder().decode(bytes)
}

function parseJson(text: string): Result<unknown, string> {
  try {
    return ok(JSON.parse(text))
  } catch (e) {
    return err(`not JSON: ${errorMessage(e)}`)
  }
}

export const jsonCodec: Codec = {
  name: 'json',
  encodeInput: (input) => JSON.stringify(input),
  decodeInput(data) {
    const raw = parseJson(decodeText(data))
    if (!raw.ok) return raw
    const parsed = ClientMessageSchema.safeParse(raw.value)
    if (!parsed.success || parsed.data.type !== 'input') return err('not an input message')
    return ok(parsed.data)
  },
  encodeSnapshot: (snapshot) => JSON.stringify(snapshot),
  decodeSnapshot(data) {
    const raw = parseJson(decodeText(data))
    if (!raw.ok) return raw
    const parsed = SnapshotSchema.safeParse(raw.value) // знімок від сервера теж перевіряємо — межа є межа
    return parsed.success ? ok(parsed.data) : err(parsed.error.issues[0]?.message ?? 'bad snapshot')
  },
}

// бінарний декодер кидає DecodeError на смітті — тут перетворюємо на Result
function attempt<T>(fn: () => T): Result<T, string> {
  try {
    return ok(fn())
  } catch (e) {
    return err(errorMessage(e))
  }
}

export const binaryCodec: Codec = {
  name: 'binary',
  encodeInput,
  decodeInput: (data) => {
    if (typeof data === 'string') return err('binary codec got a text frame')
    return attempt(() => {
      const m = decodeInput(data)
      // зайва перевірка тією самою схемою, що й JSON: правила (діапазон seq тощо) — в одному місці
      return InputMessage.parse(m)
    })
  },
  encodeSnapshot,
  decodeSnapshot: (data) => {
    if (typeof data === 'string') return err('binary codec got a text frame')
    return attempt(() => decodeSnapshot(data))
  },
}

export const codecs: Readonly<Record<Codec['name'], Codec>> = { json: jsonCodec, binary: binaryCodec }

export function byteSize(encoded: Encoded): number {
  return typeof encoded === 'string' ? new TextEncoder().encode(encoded).byteLength : encoded.byteLength
}
