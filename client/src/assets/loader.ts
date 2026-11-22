import { z } from 'zod'

// Конвеєр завантаження ассетів (Lab 3), Lab 6 — під strict.
// Усі функції приймають AbortSignal і не торкаються DOM під час імпорту,
// тому модуль можна тестувати в Node (tests/loader.test.ts).

// ---------- маніфест: формат перевіряється схемою (це межа з файлом) ----------
const Rect = z.tuple([z.number(), z.number(), z.number(), z.number()]) // [x, y, w, h] кадру в спрайт-листі
export type Rect = z.infer<typeof Rect>
const Frames = z.record(z.string(), z.union([Rect, z.array(Rect)]))
export type Frames = z.infer<typeof Frames>

export const ManifestItemSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['image', 'audio', 'json']),
  url: z.string().min(1),
  optional: z.boolean().optional(),
  timeoutMs: z.number().positive().optional(),
  frames: Frames.optional(),
})
export type ManifestItem = z.infer<typeof ManifestItemSchema>
export const ManifestSchema = z.object({ version: z.number().optional(), items: z.array(ManifestItemSchema) })
export type Manifest = z.infer<typeof ManifestSchema>

// ---------- помилки ----------

// Сервер відповів, але не 2xx. fetch НЕ відхиляє проміс на 404 — це робимо ми.
export class HttpError extends Error {
  override name = 'HttpError'
  readonly status: number
  readonly url: string
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`)
    this.status = status
    this.url = url
  }
}

// Відповідь прийшла, але це не валідний JSON / не картинка / не звук. Повторювати безглуздо.
export class AssetFormatError extends Error {
  override name = 'AssetFormatError'
  readonly url: string
  constructor(message: string, url: string, cause?: unknown) {
    super(`${message}: ${url}`, { cause })
    this.url = url
  }
}

export const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError'
export const isTimeout = (e: unknown): boolean => e instanceof Error && e.name === 'TimeoutError'

// Чи має сенс спробувати ще раз?
export function isRetryable(e: unknown): boolean {
  if (isAbort(e)) return false // користувач сам скасував
  if (e instanceof HttpError) return e.status >= 500 || e.status === 408 || e.status === 429 // 4xx — ні
  if (e instanceof AssetFormatError) return false
  if (isTimeout(e)) return true // сервер не встиг — може, наступного разу встигне
  if (e instanceof TypeError) return true // мережева помилка fetch (немає з'єднання, обрив)
  return false
}

// ---------- утиліти ----------

// setTimeout у вигляді проміса, який можна перервати сигналом
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(id)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Об'єднує сигнал користувача з таймаутом на ОДНУ спробу.
export function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (!timeoutMs) return signal
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export interface RetryInfo {
  readonly attempt: number
  readonly delay: number
  readonly error: unknown
}
export interface RetryOptions {
  attempts?: number
  baseMs?: number
  maxMs?: number
  signal?: AbortSignal
  onRetry?: (info: RetryInfo) => void
  random?: () => number
}

// Повтор з експоненційною затримкою та jitter ("equal jitter").
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  { attempts = 3, baseMs = 250, maxMs = 4000, signal, onRetry, random = Math.random }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    try {
      return await fn(attempt)
    } catch (e: unknown) {
      if (attempt >= attempts || !isRetryable(e) || signal?.aborted) throw e
      const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1))
      const delay = exp / 2 + random() * (exp / 2)
      onRetry?.({ attempt, delay, error: e })
      await sleep(delay, signal)
    }
  }
}

// ---------- завантажувачі ----------

export interface FetchOptions {
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
}

async function fetchOk(url: string, { signal, timeoutMs }: FetchOptions = {}): Promise<Response> {
  const s = withTimeout(signal, timeoutMs)
  const res = await fetch(url, s ? { signal: s } : {})
  if (!res.ok) throw new HttpError(res.status, url) // 404/500: проміс fetch виконався, але для нас це помилка
  return res
}

// Результат — unknown: що всередині, вирішує той, хто викликає (схемою)
export async function fetchJson(url: string, options?: FetchOptions): Promise<unknown> {
  const res = await fetchOk(url, options)
  const text = await res.text() // крок 2: тіло читається окремо і теж може впасти
  try {
    const data: unknown = JSON.parse(text)
    return data
  } catch (e: unknown) {
    throw new AssetFormatError('Corrupt JSON', url, e)
  }
}

export const loadJson = fetchJson

export async function loadImage(url: string, options?: FetchOptions): Promise<HTMLImageElement> {
  const res = await fetchOk(url, options)
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  const img = new Image()
  img.src = objectUrl
  try {
    await img.decode()
  } catch (e: unknown) {
    throw new AssetFormatError('Cannot decode image', url, e)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
  return img
}

export async function loadAudio(
  audioCtx: BaseAudioContext,
  url: string,
  options?: FetchOptions,
): Promise<AudioBuffer> {
  const res = await fetchOk(url, options)
  const data = await res.arrayBuffer()
  try {
    // AudioContext може бути ще "suspended" (до першого кліку) — декодувати це не заважає
    return await audioCtx.decodeAudioData(data)
  } catch (e: unknown) {
    throw new AssetFormatError('Cannot decode audio', url, e)
  }
}

// ---------- весь маніфест ----------

export interface Failure {
  readonly item: ManifestItem
  readonly error: unknown
}
export interface Progress {
  readonly done: number
  readonly total: number
  readonly failed: readonly Failure[]
  readonly item: ManifestItem
  readonly ok: boolean
  readonly error?: unknown
}
export interface LoadOptions {
  audioCtx?: BaseAudioContext | null
  signal?: AbortSignal
  timeoutMs?: number
  retry?: Omit<RetryOptions, 'signal' | 'onRetry'>
  onRetry?: (info: RetryInfo & { item: ManifestItem }) => void
  onProgress?: (p: Progress) => void
}
export interface LoadedAssets {
  readonly images: Readonly<Record<string, HTMLImageElement>>
  readonly sounds: Readonly<Record<string, AudioBuffer>>
  readonly json: Readonly<Record<string, unknown>>
  readonly frames: Readonly<Record<string, Frames>>
  readonly failed: readonly Failure[]
  readonly total: number
}

// розмічене об'єднання: kind каже, що всередині (instanceof AudioBuffer впав би там, де нема Web Audio)
type Loaded =
  | { readonly kind: 'image'; readonly value: HTMLImageElement }
  | { readonly kind: 'audio'; readonly value: AudioBuffer }
  | { readonly kind: 'json'; readonly value: unknown }
  | null

function loadItem(item: ManifestItem, o: LoadOptions): Promise<Loaded> {
  const opts: FetchOptions = { signal: o.signal, timeoutMs: item.timeoutMs ?? o.timeoutMs }
  const once = async (): Promise<Loaded> => {
    switch (item.type) {
      case 'image':
        return { kind: 'image', value: await loadImage(item.url, opts) }
      case 'audio':
        return o.audioCtx ? { kind: 'audio', value: await loadAudio(o.audioCtx, item.url, opts) } : null
      case 'json':
        return { kind: 'json', value: await loadJson(item.url, opts) }
    }
  }
  return withRetry(once, {
    ...o.retry,
    ...(o.signal ? { signal: o.signal } : {}),
    onRetry: (info) => o.onRetry?.({ item, ...info }),
  })
}

interface State {
  done: number
  readonly total: number
  readonly failed: Failure[]
}

// Обгортка для прогресу: кожен проміс окремо повідомляє "я готовий" — і тоді вже йде в Promise.all.
function track(
  promise: Promise<Loaded>,
  item: ManifestItem,
  state: State,
  onProgress?: (p: Progress) => void,
): Promise<Loaded> {
  return promise.then(
    (value) => {
      state.done++
      onProgress?.({ ...state, item, ok: true })
      return value
    },
    (error: unknown) => {
      // Abort і помилки обов'язкових ассетів не ковтаємо — Promise.all має впасти
      if (isAbort(error) || !item.optional) throw error
      state.done++
      state.failed.push({ item, error })
      onProgress?.({ ...state, item, ok: false, error })
      return null // необов'язковий ассет: гра піде з запасним варіантом
    },
  )
}

function collect(
  items: readonly ManifestItem[],
  values: readonly Loaded[],
  failed: readonly Failure[],
): LoadedAssets {
  const images: Record<string, HTMLImageElement> = {}
  const sounds: Record<string, AudioBuffer> = {}
  const json: Record<string, unknown> = {}
  const frames: Record<string, Frames> = {}
  items.forEach((item, i) => {
    if (item.frames) frames[item.key] = item.frames
    const value = values[i]
    if (!value) return
    switch (value.kind) {
      case 'image':
        images[item.key] = value.value
        break
      case 'audio':
        sounds[item.key] = value.value
        break
      case 'json':
        json[item.key] = value.value
        break
    }
  })
  return { images, sounds, json, frames, failed, total: items.length }
}

// ПАРАЛЕЛЬНО: усі запити стартують одразу.
export async function loadAll(
  manifest: Manifest,
  { onProgress, ...options }: LoadOptions = {},
): Promise<LoadedAssets> {
  const { items } = manifest
  const state: State = { done: 0, total: items.length, failed: [] }
  const values = await Promise.all(
    items.map((item) => track(loadItem(item, options), item, state, onProgress)),
  )
  return collect(items, values, state.failed)
}

// ПОСЛІДОВНО: кожен наступний чекає попередній. Лише для порівняння часу (README Lab 3).
export async function loadAllSequential(
  manifest: Manifest,
  { onProgress, ...options }: LoadOptions = {},
): Promise<LoadedAssets> {
  const { items } = manifest
  const state: State = { done: 0, total: items.length, failed: [] }
  const values: Loaded[] = []
  for (const item of items) values.push(await track(loadItem(item, options), item, state, onProgress))
  return collect(items, values, state.failed)
}
