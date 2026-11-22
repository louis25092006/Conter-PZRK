// Дослід M4: що буде з чатом, якщо один HTTP-обробник заблокує цикл подій на 300 мс?
//   node scripts/block-demo.js
// Два гравці в одній кімнаті: A шле повідомлення кожні 100 мс, міряємо, скільки воно
// йде до B (сервер → розсилка). На 1-й і 2-й секунді хтось викликає GET /api/slow?ms=300.

import { spawn } from 'node:child_process'
import { get } from 'node:http'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const PORT = 3101
const server = spawn(process.execPath, ['src/index.js'], {
  cwd: join(import.meta.dirname, '..'),
  env: {
    ...process.env,
    PORT: String(PORT),
    DEMO_ENDPOINTS: 'true',
    QUIET: 'true',
    RATE_LIMIT_PER_SEC: '50',
  },
  stdio: 'inherit',
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function player(name) {
  for (;;) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      ws.on('error', () => {})
      ws.send(JSON.stringify({ type: 'join', v: 0, roomId: 'r-classic', name }))
      await new Promise((r) => ws.once('message', r))
      return ws
    } catch {
      await sleep(100) // сервер ще стартує
    }
  }
}

try {
  const a = await player('A')
  const b = await player('B')
  const sentAt = new Map()
  const rows = []
  const t0 = performance.now()
  b.on('message', (data) => {
    const m = JSON.parse(data)
    if (m.type !== 'chat' || !sentAt.has(m.text)) return
    const t = performance.now()
    rows.push({ at: (sentAt.get(m.text) - t0) / 1000, latency: t - sentAt.get(m.text) })
  })

  const slowCalls = []
  for (const at of [1000, 2000]) {
    setTimeout(() => {
      const start = performance.now()
      get({ port: PORT, path: '/api/slow?ms=300' }, (res) => {
        res.resume()
        res.on('end', () => slowCalls.push({ at: at / 1000, ms: performance.now() - start }))
      })
    }, at)
  }

  for (let i = 0; i < 30; i++) {
    const text = `msg ${i}`
    sentAt.set(text, performance.now())
    a.send(JSON.stringify({ type: 'chat', text }))
    await sleep(100)
  }
  await sleep(500)

  console.log('Затримка доставки повідомлення A → сервер → B:')
  for (const r of rows) {
    const bar = '█'.repeat(Math.max(1, Math.round(r.latency / 10)))
    console.log(`  t=${r.at.toFixed(1)}s  ${r.latency.toFixed(1).padStart(6)} ms  ${bar}`)
  }
  const normal = rows.filter((r) => r.latency < 50).map((r) => r.latency)
  console.log(
    `\nзвичайна затримка: медіана ${normal.sort((x, y) => x - y)[normal.length >> 1].toFixed(1)} ms`,
  )
  console.log(`максимум: ${Math.max(...rows.map((r) => r.latency)).toFixed(1)} ms`)
  for (const c of slowCalls) console.log(`/api/slow на t=${c.at}s відповів за ${c.ms.toFixed(0)} ms`)
  a.close()
  b.close()
} finally {
  server.kill()
}
