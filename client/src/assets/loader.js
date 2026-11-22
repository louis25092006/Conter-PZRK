// Конвеєр завантаження ассетів.
// Усі функції приймають AbortSignal і не торкаються DOM під час імпорту,
// тому модуль можна тестувати в Node (tests/loader.test.js).

// ---------- помилки ----------

// Сервер відповів, але не 2xx. fetch НЕ відхиляє проміс на 404 — це робимо ми.
export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
  }
}

// Відповідь прийшла, але це не валідний JSON / не картинка / не звук.
// Повторювати безглуздо — файл зіпсований, а не мережа.
export class AssetFormatError extends Error {
  constructor(message, url, cause) {
    super(`${message}: ${url}`, { cause })
    this.name = 'AssetFormatError'
    this.url = url
  }
}

export const isAbort = (err) => err?.name === 'AbortError'

// Чи має сенс спробувати ще раз?
export function isRetryable(err) {
  if (isAbort(err)) return false // користувач сам скасував
  if (err instanceof HttpError) return err.status >= 500 || err.status === 408 || err.status === 429 // 4xx — ні
  if (err instanceof AssetFormatError) return false
  if (err?.name === 'TimeoutError') return true // сервер не встиг — може, наступного разу встигне
  if (err instanceof TypeError) return true // мережева помилка fetch (немає з'єднання, обрив)
  return false
}

// ---------- утиліти ----------

// setTimeout у вигляді проміса, який можна перервати сигналом
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(id)
      reject(signal.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Об'єднує сигнал користувача з таймаутом на ОДНУ спробу.
// Скасував користувач → AbortError, минув час → TimeoutError.
export function withTimeout(signal, timeoutMs) {
  if (!timeoutMs) return signal
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

// Повтор з експоненційною затримкою та jitter ("equal jitter"):
// спроба 1 → пауза ~[base/2, base], 2 → ~[base, 2·base], 3 → ~[2·base, 4·base]...
// Jitter потрібен, щоб тисяча клієнтів після збою сервера не прийшла знову в ту саму мілісекунду.
export async function withRetry(
  fn,
  { attempts = 3, baseMs = 250, maxMs = 4000, signal, onRetry, random = Math.random } = {},
) {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    try {
      return await fn(attempt)
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err) || signal?.aborted) throw err
      const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1))
      const delay = exp / 2 + random() * (exp / 2)
      onRetry?.({ attempt, delay, error: err })
      await sleep(delay, signal)
    }
  }
}

// ---------- завантажувачі ----------

async function fetchOk(url, { signal, timeoutMs } = {}) {
  const res = await fetch(url, { signal: withTimeout(signal, timeoutMs) })
  if (!res.ok) throw new HttpError(res.status, url) // 404/500: проміс fetch виконався, але для нас це помилка
  return res
}

export async function fetchJson(url, options) {
  const res = await fetchOk(url, options)
  const text = await res.text() // крок 2: тіло читається окремо і теж може впасти
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new AssetFormatError('Corrupt JSON', url, err)
  }
}

export const loadJson = (url, options) => fetchJson(url, options)

export async function loadImage(url, options) {
  const res = await fetchOk(url, options)
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  const img = new Image()
  img.src = objectUrl
  try {
    await img.decode()
  } catch (err) {
    throw new AssetFormatError('Cannot decode image', url, err)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
  return img
}

export async function loadAudio(audioCtx, url, options) {
  const res = await fetchOk(url, options)
  const data = await res.arrayBuffer()
  try {
    // AudioContext може бути ще "suspended" (до першого кліку) — декодувати це не заважає
    return await audioCtx.decodeAudioData(data)
  } catch (err) {
    throw new AssetFormatError('Cannot decode audio', url, err)
  }
}

// ---------- весь маніфест ----------

function loadItem(item, { audioCtx, signal, timeoutMs, retry, onRetry }) {
  const opts = { signal, timeoutMs: item.timeoutMs ?? timeoutMs }
  const once = () => {
    switch (item.type) {
      case 'image':
        return loadImage(item.url, opts)
      case 'audio':
        return audioCtx ? loadAudio(audioCtx, item.url, opts) : Promise.resolve(null)
      case 'json':
        return loadJson(item.url, opts)
      default:
        return Promise.reject(new Error(`Unknown asset type: ${item.type}`))
    }
  }
  return withRetry(once, { ...retry, signal, onRetry: (info) => onRetry?.({ item, ...info }) })
}

// Обгортка для прогресу: Promise.all нічого не каже до самого кінця,
// тому кожен проміс окремо повідомляє "я готовий" — і тоді вже йде в all.
function track(promise, item, state, onProgress) {
  return promise.then(
    (value) => {
      state.done++
      onProgress?.({ ...state, item, ok: true })
      return value
    },
    (error) => {
      // Abort і помилки обов'язкових ассетів не ковтаємо — Promise.all має впасти
      if (isAbort(error) || !item.optional) throw error
      state.done++
      state.failed.push({ item, error })
      onProgress?.({ ...state, item, ok: false, error })
      return null // необов'язковий ассет: гра піде з запасним варіантом
    },
  )
}

function emptyResult(items) {
  return { images: {}, sounds: {}, json: {}, frames: {}, failed: [], total: items.length }
}

function store(result, item, value) {
  if (item.frames) result.frames[item.key] = item.frames
  if (value === null) return
  if (item.type === 'image') result.images[item.key] = value
  else if (item.type === 'audio') result.sounds[item.key] = value
  else result.json[item.key] = value
}

// ПАРАЛЕЛЬНО: усі запити стартують одразу.
export async function loadAll(manifest, { onProgress, ...options } = {}) {
  const { items } = manifest
  const state = { done: 0, total: items.length, failed: [] }
  const values = await Promise.all(
    items.map((item) => track(loadItem(item, options), item, state, onProgress)),
  )
  const result = emptyResult(items)
  items.forEach((item, i) => store(result, item, values[i]))
  result.failed = state.failed
  return result
}

// ПОСЛІДОВНО: кожен наступний чекає попередній. Лише для порівняння часу (README).
export async function loadAllSequential(manifest, { onProgress, ...options } = {}) {
  const { items } = manifest
  const state = { done: 0, total: items.length, failed: [] }
  const result = emptyResult(items)
  for (const item of items) {
    store(result, item, await track(loadItem(item, options), item, state, onProgress))
  }
  result.failed = state.failed
  return result
}
