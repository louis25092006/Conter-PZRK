import { fetchJson, isAbort } from '../assets/loader.js'

// Лобі — логіка без DOM. Воно лише вантажить кімнати й оголошує події:
//   'rooms'   — прийшов свіжий список   (detail: { rooms, at })
//   'error'   — запит не вдався          (detail: { error })
//   'loading' — пішов запит
//   'join'    — гравець заходить у кімнату (detail: { room, name })
//   'created' — кімнату створено (detail: { room })
//   'close'   — лобі закрилось
// Малює все це окремий модуль lobby-view.js, який просто слухає події.
export class Lobby extends EventTarget {
  #controller = null // живе, поки лобі відкрите; abort() = прибрати все
  #timer = null

  constructor({ url = '/api/rooms', intervalMs = 4000, timeoutMs = 3000 } = {}) {
    super()
    this.url = url
    this.intervalMs = intervalMs
    this.timeoutMs = timeoutMs
    this.rooms = []
    this.stats = { requests: 0, ok: 0, failed: 0, aborted: 0 }
    // Офлайн-режим: якщо сервера немає зовсім (Live Server у VS Code, GitHub Pages, статичний хостинг),
    // лобі показує ці кімнати для одиночної гри. Інтервал далі перевіряє, чи не з'явився сервер.
    this.offlineRooms = []
    this.offline = false
    this.everOnline = false
  }

  get isOpen() {
    return this.#controller !== null
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }

  open() {
    if (this.isOpen) return
    this.#controller = new AbortController()
    const { signal } = this.#controller
    this.refresh()
    this.#timer = setInterval(() => this.refresh(), this.intervalMs)
    // один сигнал прибирає і таймер, і всі запити в польоті
    signal.addEventListener('abort', () => clearInterval(this.#timer), { once: true })
  }

  async refresh() {
    if (!this.isOpen) return
    const leave = this.#controller.signal
    // запит переривається, якщо гравець пішов з лобі АБО сервер мовчить довше timeoutMs
    const signal = AbortSignal.any([leave, AbortSignal.timeout(this.timeoutMs)])
    this.stats.requests++
    this.#emit('loading')
    try {
      const data = await fetchJson(this.url, { signal })
      if (leave.aborted) return
      if (!Array.isArray(data?.rooms)) throw new Error('unexpected /api/rooms response')
      this.rooms = data.rooms
      this.offline = false
      this.everOnline = true
      this.stats.ok++
      this.#emit('rooms', { rooms: this.rooms, at: new Date(), offline: false })
    } catch (error) {
      if (leave.aborted && isAbort(error)) {
        this.stats.aborted++ // гравець пішов — це не помилка, просто тихо виходимо
        return
      }
      this.stats.failed++
      // Сервер жодного разу не відповів, і це не "повільно", а "його тут немає"
      // (404 від статичного сервера, 5xx від проксі, мережева помилка) → офлайн
      const noServer =
        error.name === 'HttpError' || error.name === 'AssetFormatError' || error instanceof TypeError
      if (!this.everOnline && noServer && this.offlineRooms.length) {
        this.offline = true
        this.rooms = this.offlineRooms
        this.#emit('rooms', { rooms: this.rooms, at: new Date(), offline: true })
        return
      }
      this.#emit('error', { error })
    }
  }

  // Lab 4: POST /api/rooms на справжньому сервері
  async createRoom(name, arena) {
    if (this.offline) {
      this.#emit('error', {
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
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      this.#emit('created', { room: data })
      await this.refresh()
      return data
    } catch (error) {
      this.#emit('error', { error })
      return null
    }
  }

  join(roomId, name) {
    const room = this.rooms.find((r) => r.id === roomId)
    if (!room) return this.#emit('error', { error: new Error('Кімнату не знайдено') })
    if (room.players >= room.maxPlayers) return this.#emit('error', { error: new Error('Кімната заповнена') })
    this.close()
    this.#emit('join', { room, name: name.trim() || 'Pilot' })
  }

  close() {
    if (!this.isOpen) return
    this.#controller.abort() // скасовує запит у польоті + зупиняє інтервал
    this.#controller = null
    this.#emit('close')
  }
}
