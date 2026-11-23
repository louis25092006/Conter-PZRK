// Lab 7, M4: заміри «частинки на головному потоці vs у Worker».
// Відкривається як /worker-bench.html (Vite dev); результат — у window.benchResult.
// Запуск без браузера руками: node scripts/bench-worker.ts (Playwright headless Chromium).
import { createParticles, burst, stepParticles, STRIDE, type ParticleBuffer } from '../fx/particles.ts'
import { createRng } from '../../../shared/src/sim/random.ts'

const FRAMES = 300
const DT = 1 / 60

export interface BenchRow {
  readonly particles: number
  readonly mode: 'main' | 'worker-transfer' | 'worker-clone'
  readonly mainMsP50: number // скільки часу головного потоку забирає частинкам один кадр
  readonly mainMsP95: number
  readonly roundTripMsP50: number // за скільки повертається результат з воркера (0 для main)
}

function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b)
  return +(s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0).toFixed(3)
}

// підтримуємо приблизно сталу кількість живих частинок: щокадру доливаємо вибухи
function refill(p: ParticleBuffer, target: number, rand: () => number): void {
  while (p.count < target * 0.9) burst(p, 800 * rand(), 450 * rand(), 40, 220, rand)
}

function runMain(target: number): BenchRow {
  const rng = createRng(1)
  const rand = (): number => rng.next()
  const p = createParticles(target * 2)
  const times: number[] = []
  for (let f = 0; f < FRAMES + 30; f++) {
    refill(p, target, rand)
    const t0 = performance.now()
    p.count = stepParticles(p.data, p.count, DT)
    if (f >= 30) times.push(performance.now() - t0) // перші 30 кадрів — розігрів JIT
  }
  return {
    particles: target,
    mode: 'main',
    mainMsP50: pct(times, 0.5),
    mainMsP95: pct(times, 0.95),
    roundTripMsP50: 0,
  }
}

async function runWorker(target: number, transfer: boolean): Promise<BenchRow> {
  const worker = new Worker(new URL('../fx/particles.worker.ts', import.meta.url), { type: 'module' })
  const rng = createRng(1)
  const rand = (): number => rng.next()
  let p = createParticles(target * 2)
  const mainTimes: number[] = []
  const trips: number[] = []
  for (let f = 0; f < FRAMES + 30; f++) {
    refill(p, target, rand)
    const sent = performance.now()
    const reply = new Promise<{ data: Float32Array; count: number; handlerMs: number }>((resolve) => {
      worker.onmessage = (e: MessageEvent<{ data: Float32Array; count: number }>) => {
        const h0 = performance.now()
        const out = { data: e.data.data, count: e.data.count }
        resolve({ ...out, handlerMs: performance.now() - h0 })
      }
    })
    const buffer = p.data.buffer
    const t0 = performance.now()
    if (transfer) worker.postMessage({ data: p.data, count: p.count, dt: DT, transfer }, [buffer])
    else worker.postMessage({ data: p.data, count: p.count, dt: DT, transfer })
    const postMs = performance.now() - t0
    if (transfer && buffer.byteLength !== 0) throw new Error('transfer did not detach the buffer')
    const r = await reply
    const received = performance.now()
    p = { data: r.data, count: r.count }
    if (f >= 30) {
      mainTimes.push(postMs + r.handlerMs)
      trips.push(received - sent)
    }
  }
  worker.terminate()
  return {
    particles: target,
    mode: transfer ? 'worker-transfer' : 'worker-clone',
    mainMsP50: pct(mainTimes, 0.5),
    mainMsP95: pct(mainTimes, 0.95),
    roundTripMsP50: pct(trips, 0.5),
  }
}

async function run(): Promise<BenchRow[]> {
  const rows: BenchRow[] = []
  for (const n of [300, 3_000, 30_000, 300_000]) {
    rows.push(runMain(n))
    rows.push(await runWorker(n, true))
    rows.push(await runWorker(n, false))
  }
  return rows
}

declare global {
  interface Window {
    benchResult?: { rows: BenchRow[]; bytesPerParticle: number }
  }
}

void run().then((rows) => {
  window.benchResult = { rows, bytesPerParticle: STRIDE * 4 }
  const pre = document.createElement('pre')
  pre.textContent = JSON.stringify(rows, null, 2)
  document.body.append(pre)
})
