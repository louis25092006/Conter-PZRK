// Lab 7, M3: профіль клієнта в headless Chromium через Chrome DevTools Protocol.
//   (спершу npm run dev)   node scripts/profile-game.ts --label before [--seconds 30] [--throttle 1]
// Сценарій: кімната Classic, клієнт літає сам (?bot=1) + 7 ботів на сервері = 8 AI-пілотів,
// усі безперервно стріляють. За --seconds секунд збираємо:
//   - час кадру p50/p95/p99 (кільцевий буфер циклу з Lab 1) і проміжки між кадрами;
//   - GC: кількість і сумарний час Minor/Major GC (з трасування devtools.timeline);
//   - топ алокацій (семплінг купи, ВКЛЮЧНО з уже зібраними об'єктами);
//   - топ функцій за self time (CPU-профіль) + flame graph у docs/lab-07/.
import { chromium } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'

const { values: args } = parseArgs({
  allowNegative: true,
  options: {
    label: { type: 'string', default: 'run' },
    seconds: { type: 'string', default: '30' },
    throttle: { type: 'string', default: '1' },
    bots: { type: 'string', default: '7' },
    url: { type: 'string', default: 'http://localhost:5173' },
    perf: { type: 'boolean', default: true },
    profilers: { type: 'boolean', default: true },
    live: { type: 'boolean', default: false }, // --live: лише об'єкти, живі в кінці (хто тримає пам'ять) // --no-profilers: лише трасування GC (профайлери самі смітять) // --no-perf: без User Timing (воно саме алокує)
  },
})
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OUT = `${ROOT}client/scripts/profiles`
const DOCS = `${ROOT}docs/lab-07`
mkdirSync(OUT, { recursive: true })
mkdirSync(DOCS, { recursive: true })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
function pct(values: readonly number[], p: number): number {
  const s = [...values].sort((a, b) => a - b)
  return +(s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0).toFixed(2)
}

// ---- форми даних з CDP (перевіряємо zod — це теж «дані ззовні») ----
const CallFrame = z.object({ functionName: z.string(), url: z.string(), lineNumber: z.number() })
const label = (f: z.infer<typeof CallFrame>): string => {
  const file = f.url
    .replace(/^.*\/(client|shared)\/src\//, '$1/')
    .replace(/\?.*$/, '')
    .replace(/^.*\/node_modules\/\.vite\/deps\//, 'deps/')
  return `${f.functionName || '(anonymous)'} ${file ? `${file}:${f.lineNumber + 1}` : ''}`.trim()
}
interface HeapNode {
  callFrame: z.infer<typeof CallFrame>
  selfSize: number
  children: HeapNode[]
}
const HeapNodeSchema: z.ZodType<HeapNode> = z.lazy(() =>
  z.object({ callFrame: CallFrame, selfSize: z.number(), children: z.array(HeapNodeSchema) }),
)
const HeapProfile = z.object({ profile: z.object({ head: HeapNodeSchema }) })
const CpuProfile = z.object({
  profile: z
    .object({
      // loose(): zod інакше відкине children — і дерево викликів для flame graph зникне
      nodes: z.array(z.object({ id: z.number(), callFrame: CallFrame }).loose()).min(1),
      samples: z.array(z.number()),
      timeDeltas: z.array(z.number()),
    })
    .loose(),
})
const TraceEvent = z
  .object({
    name: z.string(),
    ph: z.string().optional(),
    dur: z.number().optional(),
    ts: z.number().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .loose()
const Trace = z.object({ traceEvents: z.array(TraceEvent) })
const Samples = z.object({
  frameMs: z.array(z.number()),
  intervalMs: z.array(z.number()),
  entities: z.number(),
})

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.goto(`${args.url}/?autojoin=r-classic&name=Perf&bot=1${args.perf ? '&perf=1' : ''}`)
  await page.waitForFunction(
    () => {
      const g: unknown = Reflect.get(window, 'game')
      // Lab 7: window.game.session; у коді Lab 6 (профіль «ДО») — window.game.game
      const live: unknown =
        typeof g === 'object' && g !== null ? (Reflect.get(g, 'session') ?? Reflect.get(g, 'game')) : null
      return live !== null && live !== undefined
    },
    null,
    { timeout: 30_000 },
  )
  const res = await fetch(`${args.url}/api/rooms/r-classic/bots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count: Number(args.bots) }),
  })
  if (!res.ok) throw new Error(`bots: HTTP ${res.status}`)
  await sleep(3000) // розігрів: боти розлітаються, JIT оптимізує гарячі функції

  const cdp = await page.context().newCDPSession(page)
  if (args.throttle !== '1') await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(args.throttle) })
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('HeapProfiler.enable')
  await browser.startTracing(page, { categories: ['devtools.timeline', 'v8', 'blink.user_timing'] })
  if (args.profilers)
    await cdp.send('HeapProfiler.startSampling', {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: !args.live,
      includeObjectsCollectedByMinorGC: !args.live,
    })
  if (args.profilers) await cdp.send('Profiler.start')
  await page.evaluate(() => {
    const g: unknown = Reflect.get(window, 'game')
    const loop: unknown = typeof g === 'object' && g !== null ? Reflect.get(g, 'loop') : null
    const reset: unknown =
      typeof loop === 'object' && loop !== null ? Reflect.get(loop, 'resetSamples') : null
    if (typeof reset === 'function') Reflect.apply(reset, loop, [])
  })

  await sleep(Number(args.seconds) * 1000)

  const empty = {
    profile: {
      nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0 } }],
      samples: [],
      timeDeltas: [],
    },
  }
  const emptyHeap = {
    profile: {
      head: { callFrame: { functionName: '(root)', url: '', lineNumber: 0 }, selfSize: 0, children: [] },
    },
  }
  const cpu = CpuProfile.parse(args.profilers ? await cdp.send('Profiler.stop') : empty)
  const heap = HeapProfile.parse(args.profilers ? await cdp.send('HeapProfiler.stopSampling') : emptyHeap)
  const trace = Trace.parse(JSON.parse((await browser.stopTracing()).toString('utf8')))
  const samples = Samples.parse(
    await page.evaluate(() => {
      const g: unknown = Reflect.get(window, 'game')
      const at = (o: unknown, k: string): unknown =>
        typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined
      const loop = at(g, 'loop')
      const fn = at(loop, 'samples')
      const s: unknown = typeof fn === 'function' ? Reflect.apply(fn, loop, []) : null
      const fm = at(s, 'frameMs')
      const im = at(s, 'intervalMs')
      const hud = at(at(at(g, 'session'), 'game'), 'hudWorld')
      return {
        frameMs: fm instanceof Float64Array ? [...fm] : [],
        intervalMs: im instanceof Float64Array ? [...im].slice(1) : [],
        entities: Number(at(hud, 'size') ?? 0),
      }
    }),
  )
  const userTiming: unknown = await page.evaluate(() => {
    const g: unknown = Reflect.get(window, 'game')
    const fn: unknown = typeof g === 'object' && g !== null ? Reflect.get(g, 'perf') : null
    const summary: unknown = typeof fn === 'function' ? Reflect.apply(fn, g, []) : null
    return summary
  })

  // ---- GC ----
  const gc = { minor: 0, minorMs: 0, major: 0, majorMs: 0, maxMs: 0 }
  const majorEvents: unknown[] = []
  const t0 = Math.min(
    ...trace.traceEvents.filter((e) => e.ph === 'X' && (e.ts ?? 0) > 0).map((e) => e.ts ?? Infinity),
  )
  for (const e of trace.traceEvents) {
    if (e.ph !== 'X' || e.dur === undefined) continue
    const ms = e.dur / 1000
    if (e.name === 'MinorGC') {
      gc.minor++
      gc.minorMs += ms
    } else if (e.name === 'MajorGC') {
      gc.major++
      gc.majorMs += ms
      majorEvents.push({ atSec: +(((e.ts ?? 0) - t0) / 1e6).toFixed(1), ms: +ms.toFixed(2), args: e.args })
    } else continue
    gc.maxMs = Math.max(gc.maxMs, ms)
  }

  // ---- топ алокацій (selfSize за функцією) ----
  const alloc = new Map<string, number>()
  let allocTotal = 0
  const walk = (n: HeapNode): void => {
    if (n.selfSize > 0) {
      const k = label(n.callFrame)
      alloc.set(k, (alloc.get(k) ?? 0) + n.selfSize)
      allocTotal += n.selfSize
    }
    n.children.forEach(walk)
  }
  walk(heap.profile.head)
  const topAlloc = [...alloc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)

  // ---- топ self time ----
  const nodeName = new Map(cpu.profile.nodes.map((n) => [n.id, label(n.callFrame)]))
  const self = new Map<string, number>()
  let cpuTotal = 0
  cpu.profile.samples.forEach((id, i) => {
    const dt = cpu.profile.timeDeltas[i] ?? 0
    cpuTotal += dt
    const k = nodeName.get(id) ?? '?'
    self.set(k, (self.get(k) ?? 0) + dt)
  })
  const topSelf = [...self.entries()]
    .filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)

  const secs = Number(args.seconds)
  const summary = {
    label: args.label,
    seconds: secs,
    throttle: Number(args.throttle),
    chromium: browser.version(),
    entitiesAtEnd: samples.entities,
    frames: samples.frameMs.length,
    frameMs: {
      p50: pct(samples.frameMs, 0.5),
      p95: pct(samples.frameMs, 0.95),
      p99: pct(samples.frameMs, 0.99),
      max: pct(samples.frameMs, 1),
    },
    intervalMs: {
      p50: pct(samples.intervalMs, 0.5),
      p95: pct(samples.intervalMs, 0.95),
      p99: pct(samples.intervalMs, 0.99),
      over20ms: samples.intervalMs.filter((x) => x > 20).length,
    },
    majorEvents,
    gc: {
      ...gc,
      minorMs: +gc.minorMs.toFixed(1),
      majorMs: +gc.majorMs.toFixed(1),
      maxMs: +gc.maxMs.toFixed(2),
    },
    allocatedMBperSec: +(allocTotal / 1048576 / secs).toFixed(2),
    topAllocators: topAlloc.map(([k, b]) => ({
      fn: k,
      MB: +(b / 1048576).toFixed(2),
      pct: +((b / allocTotal) * 100).toFixed(1),
    })),
    topSelfTime: topSelf.map(([k, us]) => ({
      fn: k,
      ms: +(us / 1000).toFixed(0),
      pct: +((us / cpuTotal) * 100).toFixed(1),
    })),
    userTiming,
  }
  const cpuFile = `${OUT}/client-${args.label}.cpuprofile`
  writeFileSync(cpuFile, JSON.stringify(cpu.profile))
  writeFileSync(`${DOCS}/client-${args.label}.json`, JSON.stringify(summary, null, 2) + '\n')
  if (args.profilers)
    spawnSync(
      process.execPath,
      [
        'scripts/flamegraph.ts',
        cpuFile,
        `${DOCS}/client-flame-${args.label}.svg`,
        '--title',
        `Клієнт ${args.label}: ${secs} с, 8 AI-пілотів`,
      ],
      {
        cwd: `${ROOT}server`,
        stdio: 'inherit',
      },
    )
  console.log(JSON.stringify(summary, null, 2))
} finally {
  await browser.close()
}
