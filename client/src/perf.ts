// Lab 7, M3: User Timing — відрізки simulate / render / decode / reconcile видно в DevTools
// (Performance → Timings) і в зведенні window.game.perf(). Увімкнення: ?perf=1.
// Без прапорця perfStart/perfEnd — це одна перевірка boolean: нуль алокацій у гарячому шляху.
// З прапорцем performance.measure створює запис щоразу, тож буфер чистимо раз на ~10 с,
// а самі тривалості складаємо в кільцеві Float64Array (вони не алокують).

export type PerfName = 'simulate' | 'render' | 'decode' | 'reconcile'
const NAMES: readonly PerfName[] = ['simulate', 'render', 'decode', 'reconcile']
const RING = 4096

export const PERF_ENABLED =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf')

const rings: Record<PerfName, { readonly buf: Float64Array; n: number }> = {
  simulate: { buf: new Float64Array(RING), n: 0 },
  render: { buf: new Float64Array(RING), n: 0 },
  decode: { buf: new Float64Array(RING), n: 0 },
  reconcile: { buf: new Float64Array(RING), n: 0 },
}
let measures = 0

export function perfStart(): number {
  return PERF_ENABLED ? performance.now() : 0
}

export function perfEnd(name: PerfName, start: number): void {
  if (!PERF_ENABLED) return
  const end = performance.now()
  performance.measure(name, { start, end })
  const r = rings[name]
  r.buf[r.n % RING] = end - start
  r.n++
  if (++measures % 2400 === 0) performance.clearMeasures() // інакше буфер записів росте без кінця
}

export interface PerfStat {
  readonly count: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
}

function pct(sorted: Float64Array, p: number): number {
  return +(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0).toFixed(3)
}

export function stats(samples: Float64Array): PerfStat {
  const s = samples.slice().sort()
  return { count: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99) }
}

export function perfSummary(): Record<PerfName, PerfStat> {
  const of = (name: PerfName): PerfStat => stats(rings[name].buf.slice(0, Math.min(rings[name].n, RING)))
  return { simulate: of('simulate'), render: of('render'), decode: of('decode'), reconcile: of('reconcile') }
}

export function perfReset(): void {
  for (const name of NAMES) rings[name].n = 0
  performance.clearMeasures()
}
