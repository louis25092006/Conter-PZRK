// Обгортка над браузерним WebSocket.
//  - повідомлення приходять як події за полем type:  conn.addEventListener('chat', e => e.detail)
//  - send() до відкриття з'єднання кладе повідомлення в чергу і надсилає після open
//  - при обриві (не нашому close) — перепідключення з експоненційною затримкою + jitter
//  - 'status' { state: 'connecting' | 'open' | 'reconnecting' | 'closed', attempt, delay, code, reason }
//
// Коди 4000–4999 від сервера означають "ти зробив щось не так" (поганий протокол,
// кімната заповнена, спам) — перепідключатись немає сенсу, це не мережа.

const RETRYABLE = new Set([1001, 1005, 1006, 1011, 1012, 1013, 4008])

export class Connection extends EventTarget {
  #socket = null
  #queue = []
  #attempt = 0
  #timer = null
  #closedByUs = false

  constructor(url, { onOpen, baseMs = 500, maxMs = 8000, maxAttempts = 8 } = {}) {
    super()
    this.url = url
    this.onOpen = onOpen // викликається після КОЖНОГО (пере)підключення — напр., щоб знову надіслати join
    this.baseMs = baseMs
    this.maxMs = maxMs
    this.maxAttempts = maxAttempts
    this.state = 'idle'
  }

  #status(state, extra = {}) {
    this.state = state
    this.dispatchEvent(new CustomEvent('status', { detail: { state, attempt: this.#attempt, ...extra } }))
  }

  connect() {
    this.#closedByUs = false
    this.#status(this.#attempt === 0 ? 'connecting' : 'reconnecting')
    const socket = new WebSocket(this.url)
    this.#socket = socket

    socket.addEventListener('open', () => {
      this.#attempt = 0
      this.#status('open')
      this.onOpen?.(this)
      // черга: усе, що намагались надіслати, поки з'єднання відкривалось
      for (const message of this.#queue.splice(0)) socket.send(JSON.stringify(message))
    })

    socket.addEventListener('message', (e) => {
      let message
      try {
        message = JSON.parse(e.data)
      } catch {
        return // сервер нам не ворог, але й падати від кривого рядка не будемо
      }
      if (typeof message?.type === 'string') {
        this.dispatchEvent(new CustomEvent(message.type, { detail: message }))
      }
    })

    socket.addEventListener('close', (e) => {
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

  send(message) {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message))
    else if (!this.#closedByUs) this.#queue.push(message)
  }

  close(code = 1000, reason = 'bye') {
    this.#closedByUs = true
    clearTimeout(this.#timer)
    this.#queue.length = 0
    this.#socket?.close(code, reason)
    this.#socket = null
    this.#status('closed', { code, reason })
  }
}

// ws://host/ws для http, wss://host/ws для https (Lab 8)
export function socketUrl(path = '/ws') {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}`
}
