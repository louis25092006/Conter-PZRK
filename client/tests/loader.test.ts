// Тести конвеєра завантаження. Запуск: npm test  (вбудований node:test, без залежностей)
// fetch підмінюємо фейком — мережа не потрібна.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  withRetry,
  fetchJson,
  loadAll,
  loadAllSequential,
  sleep,
  HttpError,
  AssetFormatError,
  isRetryable,
  type Manifest,
  type RetryInfo,
} from '../src/assets/loader.ts'

// ---------- фейковий fetch ----------
// routes[url] = масив відповідей по черзі: { status, body, delay } або 'network'
interface FakeResponse {
  readonly status?: number
  readonly body?: string
  readonly delay?: number
}
type Route = FakeResponse | 'network'
let routes: Record<string, Route[]> = {}
let calls: Record<string, number> = {}
beforeEach(() => {
  routes = {}
  calls = {}
})

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input)
  const signal = init?.signal ?? undefined
  calls[url] = (calls[url] ?? 0) + 1
  const queue = routes[url] ?? [{ status: 404, body: 'not found' }]
  const r = (queue.length > 1 ? queue.shift() : queue[0]) ?? { status: 404 }
  if (r === 'network') throw new TypeError('Failed to fetch')
  if (r.delay) await sleep(r.delay, signal) // поважає AbortSignal, як справжній fetch
  signal?.throwIfAborted()
  return new Response(r.body ?? '', { status: r.status ?? 200 })
}

const json = (obj: unknown): FakeResponse => ({ status: 200, body: JSON.stringify(obj) })
const fast = { baseMs: 5, maxMs: 20 }

// ---------- withRetry ----------

test('повторює 503, поки не вийде', async () => {
  routes['/a'] = [{ status: 503 }, { status: 503 }, json({ ok: 1 })]
  const retries: RetryInfo[] = []
  const data = await withRetry(() => fetchJson('/a'), {
    attempts: 3,
    ...fast,
    onRetry: (r) => retries.push(r),
  })
  assert.deepEqual(data, { ok: 1 })
  assert.equal(calls['/a'], 3)
  assert.deepEqual(
    retries.map((r) => r.attempt),
    [1, 2],
  )
})

test('НЕ повторює 404 (помилка клієнта — повтор не допоможе)', async () => {
  routes['/missing'] = [{ status: 404 }]
  await assert.rejects(
    withRetry(() => fetchJson('/missing'), { attempts: 5, ...fast }),
    (e) => {
      return e instanceof HttpError && e.status === 404
    },
  )
  assert.equal(calls['/missing'], 1)
})

test('здається після attempts спроб', async () => {
  routes['/down'] = [{ status: 500 }]
  await assert.rejects(
    withRetry(() => fetchJson('/down'), { attempts: 3, ...fast }),
    HttpError,
  )
  assert.equal(calls['/down'], 3)
})

test('мережеву помилку (TypeError) повторює', async () => {
  routes['/flaky'] = ['network', json([1])]
  assert.deepEqual(await withRetry(() => fetchJson('/flaky'), { ...fast }), [1])
  assert.equal(calls['/flaky'], 2)
})

test('backoff росте експоненційно, jitter у межах [exp/2, exp]', async () => {
  routes['/x'] = [{ status: 503 }]
  const lows: number[] = []
  const highs: number[] = []
  const runs: [random: () => number, out: number[]][] = [
    [() => 0, lows],
    [() => 0.999999, highs],
  ]
  for (const [random, out] of runs) {
    await withRetry(() => fetchJson('/x'), {
      attempts: 4,
      baseMs: 8,
      maxMs: 1000,
      random,
      onRetry: (r) => out.push(Math.round(r.delay)),
    }).catch(() => {})
  }
  assert.deepEqual(lows, [4, 8, 16]) // exp/2: 8/2, 16/2, 32/2
  assert.deepEqual(highs, [8, 16, 32]) // ≈ exp
})

test('битий JSON — AssetFormatError і без повторів', async () => {
  routes['/bad'] = [{ status: 200, body: '{ "a": ' }]
  await assert.rejects(
    withRetry(() => fetchJson('/bad'), { attempts: 3, ...fast }),
    AssetFormatError,
  )
  assert.equal(calls['/bad'], 1)
})

test('abort під час паузи між спробами зупиняє все', async () => {
  routes['/slow503'] = [{ status: 503 }]
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(
    withRetry(() => fetchJson('/slow503', { signal: controller.signal }), {
      attempts: 10,
      baseMs: 200,
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  )
  assert.equal(calls['/slow503'], 1)
})

test('таймаут на спробу дає TimeoutError, і його повторюють', async () => {
  routes['/hang'] = [{ status: 200, body: '{}', delay: 500 }]
  await assert.rejects(
    withRetry(() => fetchJson('/hang', { timeoutMs: 20 }), { attempts: 2, ...fast }),
    {
      name: 'TimeoutError',
    },
  )
  assert.equal(calls['/hang'], 2)
  assert.equal(isRetryable(new DOMException('t', 'TimeoutError')), true)
  assert.equal(isRetryable(new DOMException('a', 'AbortError')), false)
})

// ---------- loadAll ----------

const manifest = (items: { key: string; url: string; optional?: boolean }[]): Manifest => ({
  items: items.map((i) => ({ type: 'json', ...i })),
})

test('loadAll: прогрес на кожен файл і правильні результати', async () => {
  routes['/1'] = [json(1)]
  routes['/2'] = [json(2)]
  routes['/3'] = [json(3)]
  const progress: number[] = []
  const res = await loadAll(
    manifest([
      { key: 'a', url: '/1' },
      { key: 'b', url: '/2' },
      { key: 'c', url: '/3' },
    ]),
    { onProgress: (p) => progress.push(p.done), retry: fast },
  )
  assert.deepEqual(progress, [1, 2, 3])
  assert.deepEqual(res.json, { a: 1, b: 2, c: 3 })
})

test('loadAll: необов’язковий файл може впасти — гра все одно стартує', async () => {
  routes['/ok'] = [json('ok')]
  const res = await loadAll(
    manifest([
      { key: 'ok', url: '/ok' },
      { key: 'gone', url: '/gone', optional: true },
    ]),
    { retry: fast },
  )
  assert.equal(res.json.ok, 'ok')
  assert.equal(res.failed.length, 1)
  assert.equal(res.failed[0]?.item.key, 'gone')
})

test('loadAll: обов’язковий файл падає → весь loadAll відхиляється', async () => {
  routes['/ok'] = [json('ok')]
  await assert.rejects(
    loadAll(
      manifest([
        { key: 'ok', url: '/ok' },
        { key: 'arena', url: '/nope' },
      ]),
      { retry: fast },
    ),
    HttpError,
  )
})

test('паралельно швидше, ніж послідовно', async () => {
  for (const u of ['/s1', '/s2', '/s3', '/s4']) routes[u] = [{ status: 200, body: '1', delay: 60 }]
  const m = manifest(['/s1', '/s2', '/s3', '/s4'].map((url, i) => ({ key: `k${i}`, url })))
  let t = performance.now()
  await loadAll(m)
  const parallel = performance.now() - t
  t = performance.now()
  await loadAllSequential(m)
  const sequential = performance.now() - t
  assert.ok(parallel < 150, `parallel ${parallel}`)
  assert.ok(sequential > 220, `sequential ${sequential}`)
})

// ---------- архітектура ----------

test('симуляція не імпортує audio і hud', () => {
  const dir = new URL('../../shared/src/sim/', import.meta.url)
  for (const file of readdirSync(dir)) {
    const code = readFileSync(new URL(file, dir), 'utf8')
    assert.doesNotMatch(code, /from ['"].*(audio|hud)(\.[jt]s)?['"]/, `${file} imports audio/hud`)
    assert.doesNotMatch(code, /document\.|window\./, `${file} touches the DOM`)
  }
})
