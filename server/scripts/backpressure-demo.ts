// Дослід M3: чи тримає pipeline пам'ять сервера пласкою, коли клієнт качає ПОВІЛЬНО?
//   node scripts/backpressure-demo.js [MB/s]
// Піднімає окремий сервер (порт 3100), качає 200-МБ лог двома способами:
//   stream   — GET /api/replays/:id            (pipeline(readStream, res))
//   buffered — GET /api/demo/replay-buffered/:id (readFile цілком, потім res.end)
// Клієнт обмежує швидкість (як Network throttling у DevTools), а кожні 200 мс
// питаємо в сервера його rss через /health. Результат: CSV + SVG-графік у docs/lab-04/.

import { spawn } from 'node:child_process'
import { get } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const RATE = Number(process.argv[2] ?? 25) * 1048576 // байт/с
const PORT = 3100
const FILE = 'synthetic-200mb.ndjson'
const serverDir = join(import.meta.dirname, '..')
const docs = join(serverDir, '..', 'docs', 'lab-04')

const server = spawn(process.execPath, ['src/index.ts'], {
  cwd: serverDir,
  env: { ...process.env, PORT: String(PORT), DEMO_ENDPOINTS: 'true', QUIET: 'true' },
  stdio: 'inherit',
})
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Sample {
  t: number
  rssMB: number
}
type Mode = 'stream' | 'buffered'
interface Series {
  mode: Mode
  samples: Sample[]
  peak: number
}

function getRss(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get({ port: PORT, path }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString()))
      res.on('end', () => {
        const health: unknown = JSON.parse(body)
        if (
          typeof health === 'object' &&
          health !== null &&
          'rssMB' in health &&
          typeof health.rssMB === 'number'
        )
          resolve(health.rssMB)
        else reject(new Error('bad /health response'))
      })
    }).on('error', reject)
  })
}

// повільний клієнт: прочитав шматок — пауза, щоб середня швидкість була RATE
function throttledDownload(path: string): Promise<{ received: number; seconds: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    let received = 0
    get({ port: PORT, path }, (res) => {
      res.on('data', (chunk) => {
        received += chunk.length
        const ahead = received / RATE - (performance.now() - t0) / 1000
        if (ahead > 0) {
          res.pause()
          setTimeout(() => res.resume(), ahead * 1000)
        }
      })
      res.on('end', () => resolve({ received, seconds: (performance.now() - t0) / 1000 }))
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function measure(mode: Mode, path: string): Promise<Series> {
  await sleep(1500) // дати GC прибрати після попереднього заміру
  const samples: Sample[] = []
  const t0 = performance.now()
  let running = true
  const sampler = (async () => {
    while (running) {
      const rssMB = await getRss('/health')
      samples.push({ t: (performance.now() - t0) / 1000, rssMB })
      await sleep(200)
    }
  })()
  const result = await throttledDownload(path)
  running = false
  await sampler
  const peak = Math.max(...samples.map((s) => s.rssMB))
  console.log(
    `${mode.padEnd(8)} ${(result.received / 1048576).toFixed(0)} MB in ${result.seconds.toFixed(1)} s, ` +
      `rss min ${Math.min(...samples.map((s) => s.rssMB))} MB, peak ${peak} MB`,
  )
  return { mode, samples, peak }
}

function svgChart(series: Series[]): string {
  const W = 720
  const H = 360
  const pad = { l: 56, r: 20, t: 36, b: 44 }
  const maxT = Math.max(...series.flatMap((s) => s.samples.map((p) => p.t)))
  const maxY = Math.ceil(Math.max(...series.map((s) => s.peak)) / 50) * 50
  const x = (t: number): number => pad.l + (t / maxT) * (W - pad.l - pad.r)
  const y = (v: number): number => H - pad.b - (v / maxY) * (H - pad.t - pad.b)
  const colors: Record<Mode, string> = { stream: '#2563eb', buffered: '#dc2626' }
  const labels: Record<Mode, string> = {
    stream: 'pipeline(readStream, res)',
    buffered: 'readFile → res.end(buffer)',
  }
  let grid = ''
  for (let v = 0; v <= maxY; v += 50) {
    grid += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e7eb"/>`
    grid += `<text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#6b7280">${v}</text>`
  }
  for (let t = 0; t <= maxT; t += 2) {
    grid += `<text x="${x(t)}" y="${H - pad.b + 18}" text-anchor="middle" font-size="11" fill="#6b7280">${t}s</text>`
  }
  const lines = series
    .map((s) => {
      const d = s.samples
        .map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.rssMB).toFixed(1)}`)
        .join(' ')
      return `<path d="${d}" fill="none" stroke="${colors[s.mode]}" stroke-width="2.5"/>`
    })
    .join('')
  const legend = series
    .map(
      (s, i) =>
        `<rect x="${pad.l + 10}" y="${pad.t + 6 + i * 20}" width="14" height="4" fill="${colors[s.mode]}"/>` +
        `<text x="${pad.l + 30}" y="${pad.t + 12 + i * 20}" font-size="12" fill="#111827">${labels[s.mode]} — пік ${s.peak} МБ</text>`,
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif">
<rect width="${W}" height="${H}" fill="#ffffff"/>
<text x="${pad.l}" y="22" font-size="14" font-weight="600" fill="#111827">RSS сервера під час повільного завантаження 205 МБ логу (${RATE / 1048576} МБ/с)</text>
${grid}
<line x1="${pad.l}" x2="${pad.l}" y1="${pad.t}" y2="${H - pad.b}" stroke="#9ca3af"/>
<line x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}" stroke="#9ca3af"/>
<text x="16" y="${(H - pad.b + pad.t) / 2}" font-size="11" fill="#6b7280" transform="rotate(-90 16 ${(H - pad.b + pad.t) / 2})" text-anchor="middle">RSS, МБ</text>
${lines}${legend}
</svg>
`
}

try {
  for (let i = 0; i < 50; i++) {
    try {
      await getRss('/health')
      break
    } catch {
      await sleep(100)
    }
  }
  const stream = await measure('stream', `/api/replays/${FILE}`)
  const buffered = await measure('buffered', `/api/demo/replay-buffered/${FILE}`)
  await mkdir(docs, { recursive: true })
  const csv = [
    'mode,t_sec,rss_mb',
    ...[stream, buffered].flatMap((s) => s.samples.map((p) => `${s.mode},${p.t.toFixed(2)},${p.rssMB}`)),
  ]
  await writeFile(join(docs, 'backpressure-rss.csv'), csv.join('\n') + '\n')
  await writeFile(join(docs, 'backpressure-rss.svg'), svgChart([stream, buffered]))
  console.log('saved docs/lab-04/backpressure-rss.svg and .csv')
} finally {
  server.kill()
}
