import { fetchJson, isAbort, HttpError, AssetFormatError } from '../assets/loader.ts'
import { Bus } from '../../../shared/src/bus.ts'
import { RoomInfoSchema, RoomsResponseSchema, type RoomInfo } from '../../../shared/src/protocol.ts'
import { errorMessage } from '../../../shared/src/types.ts'

// Лобі — логіка без DOM. Воно лише вантажить кімнати й оголошує події (типізована шина).
// Малює все це окремий модуль lobby-view.ts, який просто слухає події.

// кімната в лобі: з сервера — RoomInfo; в офлайн-режимі — ще й позначка offline
export type LobbyRoom = RoomInfo & { readonly offline?: true }

export interface LobbyEvents {
  rooms: { readonly rooms: readonly LobbyRoom[]; readonly at: Date; readonly offline: boolean } // свіжий список
  error: { readonly error: unknown } // запит не вдався
  loading: undefined // пішов запит
  join: { readonly room: LobbyRoom; readonly name: string } // гравець заходить у кімнату
  created: { readonly room: RoomInfo } // кімнату створено
  close: undefined // лобі закрилось
  notice: { readonly text: string } // Lab 8: пояснення, чому гравець опинився в лобі (сервер перезапускається…)
}

export interface LobbyOptions {
  url?: string
  intervalMs?: number
  timeoutMs?: number
}

export class Lobby {
  #controller: AbortController | null = null // живе, поки лобі відкрите; abort() = прибрати все
  #timer: ReturnType<typeof setTimeout> | undefined
  #failures = 0 // Lab 8: поспіль невдалих опитувань — для backoff

  readonly events = new Bus<LobbyEvents>()
  readonly url: string
  readonly intervalMs: number
  readonly timeoutMs: number
  rooms: readonly LobbyRoom[] = []
  readonly stats = { requests: 0, ok: 0, failed: 0, aborted: 0 }
  // Офлайн-режим (Lab 4): сервера немає зовсім (Live Server, GitHub Pages) — показуємо ці кімнати
  offlineRooms: readonly LobbyRoom[] = []
  offline = false
  everOnline = false

  constructor({ url = '/api/rooms', intervalMs = 4000, timeoutMs = 3000 }: LobbyOptions = {}) {
    this.url = url
    this.intervalMs = intervalMs
    this.timeoutMs = timeoutMs
  }

  get isOpen(): boolean {
    return this.#controller !== null
  }

  open(): void {
    if (this.isOpen) return
    const controller = new AbortController()
    this.#controller = controller
    this.#failures = 0
    // Lab 8: опитування з backoff — сервер перезапускається? Не засипаємо його запитами:
    // 4 с, 8 с, 16 с… до 30 с; перша вдала відповідь повертає звичайний інтервал.
    const loop = async (): Promise<void> => {
      await this.refresh()
      if (controller.signal.aborted) return
      const delay = Math.min(30_000, this.intervalMs * 2 ** Math.min(this.#failures, 3))
      this.#timer = setTimeout(() => void loop(), delay)
    }
    void loop()
    // один сигнал прибирає і таймер, і всі запити в польоті
    controller.signal.addEventListener('abort', () => clearTimeout(this.#timer), { once: true })
  }

  // показати гравцю, чому він у лобі (після вимкнення сервера чи втрати зв'язку)
  notify(text: string): void {
    this.events.emit('notice', { text })
  }

  async refresh(): Promise<void> {
    const leave = this.#controller?.signal
    if (!leave) return
    // запит переривається, якщо гравець пішов з лобі АБО сервер мовчить довше timeoutMs
    const signal = AbortSignal.any([leave, AbortSignal.timeout(this.timeoutMs)])
    this.stats.requests++
    this.events.emit('loading', undefined)
    try {
      const parsed = RoomsResponseSchema.safeParse(await fetchJson(this.url, { signal }))
      if (!parsed.success) throw new AssetFormatError('unexpected /api/rooms response', this.url)
      if (leave.aborted) return
      this.rooms = parsed.data.rooms
      this.offline = false
      this.everOnline = true
      this.stats.ok++
      this.#failures = 0
      this.events.emit('rooms', { rooms: this.rooms, at: new Date(), offline: false })
    } catch (error: unknown) {
      if (leave.aborted && isAbort(error)) {
        this.stats.aborted++ // гравець пішов — це не помилка, просто тихо виходимо
        return
      }
      this.stats.failed++
      this.#failures++
      // Сервер жодного разу не відповів, і це не "повільно", а "його тут немає" → офлайн
      const noServer =
        error instanceof HttpError || error instanceof AssetFormatError || error instanceof TypeError
      if (!this.everOnline && noServer && this.offlineRooms.length) {
        this.offline = true
        this.rooms = this.offlineRooms
        this.events.emit('rooms', { rooms: this.rooms, at: new Date(), offline: true })
        return
      }
      this.events.emit('error', { error })
    }
  }

  // POST /api/rooms на справжньому сервері
  async createRoom(name: string, arena: string): Promise<RoomInfo | null> {
    if (this.offline) {
      this.events.emit('error', {
        error: new Error('Сервер недоступний — створювати кімнати можна лише з npm run dev'),
      })
      return null
    }
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, arena }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      const body: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? String(body.error)
            : `HTTP ${res.status}`
        throw new Error(message)
      }
      const room = RoomInfoSchema.parse(body)
      this.events.emit('created', { room })
      await this.refresh()
      return room
    } catch (error: unknown) {
      this.events.emit('error', { error: error instanceof Error ? error : new Error(errorMessage(error)) })
      return null
    }
  }

  join(roomId: string, name: string): void {
    const room = this.rooms.find((r) => r.id === roomId)
    if (!room) return this.events.emit('error', { error: new Error('Кімнату не знайдено') })
    if (room.players >= room.maxPlayers)
      return this.events.emit('error', { error: new Error('Кімната заповнена') })
    this.close()
    this.events.emit('join', { room, name: name.trim() || 'Pilot' })
  }

  close(): void {
    if (!this.#controller) return
    this.#controller.abort() // скасовує запит у польоті + зупиняє інтервал
    this.#controller = null
    this.events.emit('close', undefined)
  }
}
