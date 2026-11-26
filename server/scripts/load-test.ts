// Lab 7, M4: навантажувальний тест сервера.
//   node scripts/load-test.ts [--ramp 8,32,64,128,256] [--seconds 10] [--port 3107]
// Піднімає сервер окремим процесом, для кожного N створює кімнату на N місць і підключає
// N «безголових» WebSocket-клієнтів (бібліотека ws), які літають за скриптом і стріляють
// 60 команд/с — як справжні гравці. Міряє: тривалість тіку p50/p95/p99 (бюджет — 33 мс при 30 Гц),
// завантаженість циклу подій (ELU), пам'ять процесу (RSS) і трафік.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { binaryCodec } from '@conter/shared/codec/index.ts'
import { toSeq } from '@conter/shared/types.ts'

const { values: args } = parseArgs({
  options: {
    ramp: { type: 'string', default: '8,32,64,128,256' },
    seconds: { type: 'string', default: '10' },
    warmup: { type: 'string', default: '4' },
    port: { type: 'string', default: '3107' },
    arena: { type: 'string', default: 'classic' },
    profile: { type: 'boolean', default: false }, // node --cpu-prof на сервері → scripts/profiles/
  },
})
const PORT = Number(args.port)
const BASE = `http://127.0.0.1:${PORT}`
const RAMP = args.ramp.split(',').map(Number)
const SECONDS = Number(args.seconds)
const BUDGET_MS = 1000 / 30

const PROFILE_DIR = join(import.meta.dirname, 'profiles')
const server = spawn(
  process.execPath,
  [...(args.profile ? ['--cpu-prof', '--cpu-prof-dir', PROFILE_DIR] : []), 'src/index.ts'],
  {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      QUIET: 'true',
      MAX_PLAYERS_PER_ROOM: '512',
      MAX_CONNECTIONS_PER_IP: '10000', // усі клієнти генератора — з 127.0.0.1
      LOG_DIR: mkdtempSync(join(tmpdir(), 'conter-load-')),
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  },
)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const StatsSchema = z.object({
  matches: z.array(
    z.object({
      room: z.string(),
      players: z.number(),
      entities: z.number(),
      tickPercentiles: z.object({ p50: z.number(), p95: z.number(), p99: z.number(), samples: z.number() }),
    }),
  ),
  process: z.object({ rssMB: z.number(), heapUsedMB: z.number(), eventLoopUtilization: z.number() }),
})
async function stats(): Promise<z.infer<typeof StatsSchema>> {
  return StatsSchema.parse(await (await fetch(`${BASE}/api/stats`)).json())
}

interface Bot {
  ws: WebSocket
  seq: number
  phase: number
  bytesIn: number
  bytesOut: number
}

function connect(roomId: string, i: number): Promise<Bot> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?codec=binary`)
    const bot: Bot = { ws, seq: 0, phase: i * 37, bytesIn: 0, bytesOut: 0 }
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', v: 1, roomId, name: `load-${i}` })))
    ws.on('message', (data: Buffer, isBinary) => {
      bot.bytesIn += data.length
      if (!isBinary && data.toString().includes('"welcome"')) resolve(bot)
    })
    ws.on('error', reject)
    ws.on('close', (code) => {
      if (code !== 1000 && code !== 1005) console.warn(`client ${i} closed: ${code}`)
    })
  })
}

// скриптований політ: повороти «змійкою», майже весь час газ, постріл кожні 5 кроків
function sendInput(b: Bot): void {
  const k = b.seq + b.phase
  const turn = k % 120 < 40 ? 1 : k % 120 < 60 ? -1 : 0
  const msg = binaryCodec.encodeInput({
    type: 'input',
    seq: toSeq(++b.seq),
    turn,
    thrust: k % 9 !== 0,
    fire: k % 5 === 0,
  })
  if (typeof msg === 'string') return
  b.bytesOut += msg.byteLength
  b.ws.send(msg)
}

interface Row {
  n: number
  entities: number
  tickP50: number
  tickP95: number
  tickP99: number
  elu: number
  rssMB: number
  downKBs: number
  upKBs: number
}

async function runLevel(n: number): Promise<Row> {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `load-${n}`, arena: args.arena, maxPlayers: n }),
  })
  const room = z.object({ id: z.string() }).parse(await res.json())
  const bots: Bot[] = []
  for (let i = 0; i < n; i += 16) {
    // підключаємо пачками по 16, щоб не впертися в backlog TCP
    bots.push(
      ...(await Promise.all(Array.from({ length: Math.min(16, n - i) }, (_, j) => connect(room.id, i + j)))),
    )
  }
  // 60 команд/с на кожного клієнта; один таймер на всіх (як 60 Гц цикл у браузері)
  let sent = 0
  const t0 = performance.now()
  const timer = setInterval(() => {
    const due = Math.floor((performance.now() - t0) / (1000 / 60))
    while (sent < due) {
      for (const b of bots) sendInput(b)
      sent++
    }
  }, 4)

  await sleep(Number(args.warmup) * 1000)
  await stats() // скидаємо вікно ELU
  const in0 = bots.reduce((s, b) => s + b.bytesIn, 0)
  const out0 = bots.reduce((s, b) => s + b.bytesOut, 0)
  await sleep(SECONDS * 1000)
  const st = await stats()
  const in1 = bots.reduce((s, b) => s + b.bytesIn, 0)
  const out1 = bots.reduce((s, b) => s + b.bytesOut, 0)
  clearInterval(timer)
  const m = st.matches.find((x) => x.room === room.id)
  for (const b of bots) b.ws.close(1000)
  await sleep(1500) // кімната порожніє, матч зупиняється
  return {
    n,
    entities: m?.entities ?? 0,
    tickP50: m?.tickPercentiles.p50 ?? NaN,
    tickP95: m?.tickPercentiles.p95 ?? NaN,
    tickP99: m?.tickPercentiles.p99 ?? NaN,
    elu: st.process.eventLoopUtilization,
    rssMB: st.process.rssMB,
    downKBs: +((in1 - in0) / 1024 / SECONDS).toFixed(1),
    upKBs: +((out1 - out0) / 1024 / SECONDS).toFixed(1),
  }
}

try {
  await sleep(800)
  const rows: Row[] = []
  for (const n of RAMP) {
    const row = await runLevel(n)
    rows.push(row)
    console.log(JSON.stringify(row))
    if (row.tickP99 > BUDGET_MS) break // бюджет тіку перевищено — далі немає сенсу
  }
  console.log(
    `\n| N clients | entities | tick p50 ms | tick p95 ms | tick p99 ms | ELU | RSS MB | down KB/s (all) | up KB/s (all) |`,
  )
  console.log('|---|---|---|---|---|---|---|---|---|')
  for (const r of rows)
    console.log(
      `| ${r.n} | ${r.entities} | ${r.tickP50} | ${r.tickP95} | **${r.tickP99}** | ${r.elu} | ${r.rssMB} | ${r.downKBs} | ${r.upKBs} |`,
    )
  const over = rows.find((r) => r.tickP99 > BUDGET_MS)
  console.log(
    over
      ? `\nCapacity: tick p99 exceeds 33 ms at N = ${over.n}`
      : `\nTick p99 stayed under 33 ms up to N = ${rows.at(-1)?.n}`,
  )
} finally {
  // м'яка зупинка через IPC — щоб сервер встиг записати .cpuprofile
  const exited = new Promise((r) => server.once('exit', r))
  server.send('shutdown')
  await Promise.race([exited, sleep(8000)])
  if (server.exitCode === null) server.kill()
  if (args.profile) console.log(`CPU profile written to ${PROFILE_DIR}`)
}
