import { Bus } from '../../../shared/src/bus.ts'
import { parseServerMessage, type ServerMessage } from '../../../shared/src/protocol.ts'

// Обгортка над браузерним WebSocket (Lab 4–5), Lab 6 — під strict.
//  - кожне повідомлення сервера ПЕРЕВІРЯЄТЬСЯ схемою (parseServerMessage) і стає подією за полем type;
//  - send() до відкриття з'єднання кладе повідомлення в чергу;
//  - при обриві — перепідключення з експоненційною затримкою + jitter.

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'
export interface ConnectionStatus {
  readonly state: ConnectionState
  readonly attempt: number
  readonly delay?: number
  readonly code?: number
  readonly reason?: string
}

// Події з'єднання: КОЖНЕ серверне повідомлення під своїм type (тип виведено з протоколу!)
// + службові. conn.events.on('roster', (m) => m.players) — m точно має players.
export type ConnectionEvents = { [M in ServerMessage as M['type']]: M } & {
  status: ConnectionStatus
  binary: ArrayBuffer // бінарний кадр — знімок світу; розбирає NetGame (codec)
}

// Коди 4000–4999 від сервера означають "ти зробив щось не так" — перепідключатись немає сенсу.
const RETRYABLE: ReadonlySet<number> = new Set([1001, 1005, 1006, 1011, 1012, 1013, 4008])

export interface ConnectionOptions {
  onOpen?: (c: Connection) => void // після КОЖНОГО (пере)підключення — напр., щоб знову надіслати join
  baseMs?: number
  maxMs?: number
  maxAttempts?: number
}

export class Connection {
  #socket: WebSocket | null = null
  #queue: object[] = []
  #attempt = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #closedByUs = false

  readonly url: string
  readonly events = new Bus<ConnectionEvents>()
  readonly onOpen: ((c: Connection) => void) | undefined
  readonly baseMs: number
  readonly maxMs: number
  readonly maxAttempts: number
  state: ConnectionState = 'idle'
  bytesIn = 0 // трафік для нетграфа
  bytesOut = 0

  constructor(url: string, { onOpen, baseMs = 500, maxMs = 8000, maxAttempts = 8 }: ConnectionOptions = {}) {
    this.url = url
    this.onOpen = onOpen
    this.baseMs = baseMs
    this.maxMs = maxMs
    this.maxAttempts = maxAttempts
  }

  #status(state: ConnectionState, extra: Omit<ConnectionStatus, 'state' | 'attempt'> = {}): void {
    this.state = state
    this.events.emit('status', { state, attempt: this.#attempt, ...extra })
  }

  // перевірене повідомлення → подія з його власним типом
  #dispatch(m: ServerMessage): void {
    switch (m.type) {
      case 'welcome':
        return this.events.emit('welcome', m)
      case 'roster':
        return this.events.emit('roster', m)
      case 'chat':
        return this.events.emit('chat', m)
      case 'system':
        return this.events.emit('system', m)
      case 'pong':
        return this.events.emit('pong', m)
      case 'netsim':
        return this.events.emit('netsim', m)
      case 'snapshot':
        return this.events.emit('snapshot', m)
      default:
        return assertNeverMessage(m)
    }
  }

  connect(): void {
    this.#closedByUs = false
    this.#status(this.#attempt === 0 ? 'connecting' : 'reconnecting')
    const socket = new WebSocket(this.url)
    socket.binaryType = 'arraybuffer' // бінарні знімки приходять як ArrayBuffer
    this.#socket = socket

    socket.addEventListener('open', () => {
      this.#attempt = 0
      this.#status('open')
      this.onOpen?.(this)
      for (const message of this.#queue.splice(0)) this.#write(socket, JSON.stringify(message))
    })

    socket.addEventListener('message', (e: MessageEvent<unknown>) => {
      const data = e.data
      if (data instanceof ArrayBuffer) {
        this.bytesIn += data.byteLength
        this.events.emit('binary', data)
        return
      }
      if (typeof data !== 'string') return
      this.bytesIn += data.length
      const parsed = parseServerMessage(data)
      if (parsed.ok) this.#dispatch(parsed.value)
      else console.warn('[net] server message rejected by schema:', parsed.error)
    })

    socket.addEventListener('close', (e: CloseEvent) => {
      if (this.#socket !== socket) return
      this.#socket = null
      const { code, reason } = e
      if (this.#closedByUs || !RETRYABLE.has(code) || this.#attempt >= this.maxAttempts) {
        this.#status('closed', { code, reason })
        return
      }
      this.#attempt++
      const exp = Math.min(this.maxMs, this.baseMs * 2 ** (this.#attempt - 1))
      const delay = exp / 2 + Math.random() * (exp / 2)
      this.#status('reconnecting', { code, reason, delay })
      this.#timer = setTimeout(() => this.connect(), delay)
    })
    // 'error' у браузерному WebSocket завжди супроводжується 'close' — обробляємо там
  }

  #write(socket: WebSocket, data: string | ArrayBuffer): void {
    this.bytesOut += typeof data === 'string' ? data.length : data.byteLength
    socket.send(data)
  }

  get isOpen(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN
  }

  send(message: object): void {
    if (this.#socket && this.isOpen) this.#write(this.#socket, JSON.stringify(message))
    else if (!this.#closedByUs) this.#queue.push(message)
  }

  // вже закодоване (команди гравця 60/с); без черги — застарілі команди нікому не потрібні
  sendRaw(data: string | ArrayBuffer): void {
    if (this.#socket && this.isOpen) this.#write(this.#socket, data)
  }

  close(code = 1000, reason = 'bye'): void {
    this.#closedByUs = true
    clearTimeout(this.#timer)
    this.#queue.length = 0
    this.#socket?.close(code, reason)
    this.#socket = null
    this.#status('closed', { code, reason })
  }
}

function assertNeverMessage(m: never): never {
  throw new Error(`unhandled server message: ${JSON.stringify(m)}`)
}

// ws://host/ws для http, wss://host/ws для https (Lab 8)
export function socketUrl(path = '/ws'): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}`
}
