// Lab 7, M4: запускає worker-bench.html у headless Chromium і друкує таблицю.
//   node scripts/bench-worker.ts
import { createServer } from 'vite'
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'

interface Row {
  particles: number
  mode: string
  mainMsP50: number
  mainMsP95: number
  roundTripMsP50: number
}

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)), // шлях із кирилицею — лише через fileURLToPath
  server: { port: 5199 },
  logLevel: 'error',
})
await server.listen()
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto('http://localhost:5199/worker-bench.html')
  await page.waitForFunction(() => window.benchResult !== undefined, null, { timeout: 120_000 })
  const rows = await page.evaluate((): Row[] => window.benchResult?.rows ?? [])
  console.log(`Chromium ${browser.version()}, 300 кадрів на кожен рядок після 30 кадрів розігріву`)
  console.log('| Particles | Mode | Main thread ms/frame p50 | p95 | Round trip ms p50 |')
  console.log('|---|---|---|---|---|')
  for (const r of rows)
    console.log(
      `| ${r.particles} | ${r.mode} | ${r.mainMsP50} | ${r.mainMsP95} | ${r.roundTripMsP50 || '—'} |`,
    )
} finally {
  await browser.close()
  await server.close()
}
