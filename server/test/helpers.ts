// Спільні помічники для тестів сервера: типізований WebSocket-клієнт.
// Повідомлення сервера розбираються ТІЄЮ САМОЮ схемою, що й на справжньому клієнті
// (parseServerMessage) — тести заодно перевіряють, що сервер говорить за протоколом.
import { WebSocket, type RawData } from 'ws'
import { parseServerMessage, type ServerMessage, type Snapshot } from '@conter/shared/protocol.ts'
import { binaryCodec } from '@conter/shared/codec/index.ts'

type ByType<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>

export interface TestClient {
  readonly ws: WebSocket
  readonly inbox: ServerMessage[]
  readonly snaps: Snapshot[]
  readonly closed: Promise<number>
  open(): Promise<void>
  send(m: string | Uint8Array | ArrayBuffer | object): void
  next<T extends ServerMessage['type']>(type: T): Promise<ByType<T>>
  until(predicate: () => boolean): Promise<void>
}

const isType =
  <T extends ServerMessage['type']>(type: T) =>
  (m: ServerMessage): m is ByType<T> =>
    m.type === type

function toBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

export function connect(url: string): TestClient {
  const ws = new WebSocket(url)
  const inbox: ServerMessage[] = []
  const snaps: Snapshot[] = []
  const waiters: (() => void)[] = []
  ws.on('message', (data, isBinary) => {
    const bytes = toBytes(data)
    if (isBinary) {
      const snap = binaryCodec.decodeSnapshot(bytes)
      if (!snap.ok) throw new Error(`server sent a bad snapshot: ${snap.error}`)
      snaps.push(snap.value)
    } else {
      const m = parseServerMessage(bytes.toString('utf8'))
      if (!m.ok) throw new Error(`server broke the protocol: ${m.error}`)
      if (m.value.type === 'snapshot') snaps.push(m.value)
      else inbox.push(m.value)
    }
    for (const w of waiters.splice(0)) w()
  })
  ws.on('error', () => {})
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
  const wait = (): Promise<void> => new Promise((resolve) => waiters.push(resolve))

  return {
    ws,
    inbox,
    snaps,
    closed,
    open: () => new Promise((resolve) => ws.once('open', () => resolve())),
    send(m) {
      ws.send(
        typeof m === 'string' || m instanceof Uint8Array || m instanceof ArrayBuffer ? m : JSON.stringify(m),
      )
    },
    async next(type) {
      const match = isType(type)
      for (;;) {
        const i = inbox.findIndex(match)
        const found = inbox[i]
        if (found && match(found)) {
          inbox.splice(i, 1)
          return found
        }
        await wait()
      }
    },
    async until(predicate) {
      while (!predicate()) await wait()
    },
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
