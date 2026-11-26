// Lab 8, M2: хаос-тести на «staging» — продакшен-процес сервера (NODE_ENV=production, без --watch).
//   node scripts/chaos.ts            → таблиця в консолі + docs/lab-08/chaos.json
// Три сценарії з умови:
//   1) обірвати клієнта посеред матчу (TCP-обрив без close-кадру);
//   2) «вбити» сервер посеред матчу — м'яко (SIGTERM → shutdown + 1001) і жорстко (SIGKILL → 1006);
//      справжній клієнтський NetGame перепідключається з backoff і повертається в гру;
//   3) клієнт шле сміття 1000 кадрів/с: його закривають, логують, рахують у метриках —
//      і p99 тіку ІНШОЇ кімнати не змінюється (доводимо метрикою).
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { binaryCodec } from '@conter/shared/codec/index.ts'
import { toSeq } from '@conter/shared/types.ts'
import { NetGame } from '../../client/src/net/net-game.ts'
import type { ConnectionState } from '../../client/src/net/connection.ts'

const PORT = 3111
const BASE = `http://127.0.0.1:${PORT}`
const WS = `ws://127.0.0.1:${PORT}/ws`
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const LOG_DIR = mkdtempSync(join(tmpdir(), 'conter-chaos-'))

function startServer(): ChildProcess {
  return spawn(process.execPath, ['src/index.ts'], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      LOG_LEVEL: 'warn',
      LOG_DIR,
      MAX_CONNECTIONS_PER_IP: '1000', // усі клієнти тесту — з 127.0.0.1
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
}
async function waitReady(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`${BASE}/ready`).then(
      (r) => r.ok,
      () => false,
    )
    if (ok) return
    await sleep(100)
  }
  throw new Error('server did not become ready')
}

const Stats = z.object({
  matches: z.array(
    z.object({
      room: z.string(),
      players: z.number(),
      tickPercentiles: z.object({ p99: z.number(), samples: z.number() }),
    }),
  ),
})
async function tickP99(room: string): Promise<number> {
  const s = Stats.parse(await (await fetch(`${BASE}/api/stats`)).json())
  return s.matches.find((m) => m.room === room)?.tickPercentiles.p99 ?? NaN
}
async function metric(name: string, labels = ''): Promise<number> {
  const text = await (await fetch(`${BASE}/metrics`)).text()
  const line = text.split('\n').find((l) => l.startsWith(name + '{') && l.includes(labels))
  return line ? Number(line.split(' ').at(-1)) : 0
}

// «гравець» на ws: заходить у кімнату й шле 60 команд/с
interface Pilot {
  ws: WebSocket
  timer: ReturnType<typeof setInterval>
  closedCode: Promise<number>
}
function pilot(roomId: string, name: string): Promise<Pilot> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?codec=binary`)
    let seq = 0
    const closedCode = new Promise<number>((r) => ws.once('close', (code) => r(code)))
    ws.once('open', () => ws.send(JSON.stringify({ type: 'join', v: 1, roomId, name })))
    ws.on('message', (data: Buffer, isBinary) => {
      if (isBinary || !data.toString().includes('"welcome"')) return
      const timer = setInterval(() => {
        const msg = binaryCodec.encodeInput({
          type: 'input',
          seq: toSeq(++seq),
          turn: seq % 90 < 30 ? 1 : 0,
          thrust: true,
          fire: seq % 4 === 0,
        })
        if (typeof msg !== 'string' && ws.readyState === ws.OPEN) ws.send(msg)
      }, 1000 / 60)
      resolve({ ws, timer, closedCode })
    })
    ws.once('error', reject)
  })
}
function stop(p: Pilot): void {
  clearInterval(p.timer)
  if (p.ws.readyState === p.ws.OPEN) p.ws.close(1000)
}

const report: Record<string, unknown> = {}
let server = startServer()
try {
  await waitReady()

  // ---------- 1) обрив клієнта посеред матчу ----------
  {
    const a = await pilot('r-classic', 'A')
    const b = await pilot('r-classic', 'B')
    const victim = await pilot('r-classic', 'Victim')
    await sleep(1500)
    const before = await metric('conter_players')
    const t0 = performance.now()
    victim.ws.terminate() // як вимкнений Wi-Fi: жодного close-кадру
    let after = before
    while (after === before && performance.now() - t0 < 20_000) {
      await sleep(50)
      after = await metric('conter_players')
    }
    const p99 = await tickP99('r-classic')
    report.clientKill = {
      playersBefore: before,
      playersAfter: after,
      serverNoticedAfterMs: Math.round(performance.now() - t0),
      othersStillConnected: a.ws.readyState === a.ws.OPEN && b.ws.readyState === b.ws.OPEN,
      tickP99Ms: p99,
    }
    stop(a)
    stop(b)
    await sleep(500)
  }

  // ---------- 2) сервер падає посеред матчу; клієнт перепідключається ----------
  const statuses: {
    t: number
    state: ConnectionState
    code?: number | undefined
    delay?: number | undefined
  }[] = []
  const game = new NetGame({
    room: { id: 'r-training', name: 'Training', arenaConfig: { name: 'Training' } },
    name: 'Survivor',
    net: { url: WS },
  })
  const t0 = performance.now()
  game.conn.events.on('status', ({ state, code, delay }) =>
    statuses.push({
      t: Math.round(performance.now() - t0),
      state,
      code,
      delay: delay === undefined ? undefined : Math.round(delay),
    }),
  )
  let shutdownNotice = false
  game.conn.events.on('shutdown', () => (shutdownNotice = true))
  let welcomes = 0
  game.conn.events.on('welcome', () => welcomes++)
  while (welcomes < 1) await sleep(20)

  // 2a) м'яко: SIGTERM (тут — IPC, бо на Windows сигналів немає) → shutdown + 1001 → exit 0
  const softStart = performance.now()
  const softExit = new Promise<number | null>((r) => server.once('exit', (code) => r(code)))
  server.send?.('shutdown')
  const softCode = await softExit
  const softMs = Math.round(performance.now() - softStart)
  server = startServer()
  await waitReady()
  while (welcomes < 2 && performance.now() - softStart < 30_000) await sleep(50)
  const softBackMs = Math.round(performance.now() - softStart)

  // 2b) жорстко: SIGKILL — жодних попереджень, клієнт бачить 1006
  const hardStart = performance.now()
  server.kill('SIGKILL')
  await sleep(3000) // сервер «лежить» 3 с
  server = startServer()
  await waitReady()
  while (welcomes < 3 && performance.now() - hardStart < 30_000) await sleep(50)
  report.serverKill = {
    soft: {
      exitCode: softCode,
      shutdownTookMs: softMs,
      clientGotShutdownMessage: shutdownNotice,
      backInGameAfterMs: softBackMs,
    },
    hard: { downForMs: 3000, backInGameAfterMs: Math.round(performance.now() - hardStart) },
    rejoined: welcomes >= 3,
    connectionStatuses: statuses,
  }
  game.close()

  // ---------- 3) сміття 1000 кадрів/с проти іншої кімнати ----------
  {
    const victims = await Promise.all(Array.from({ length: 6 }, (_, i) => pilot('r-dogfight', `D${i}`)))
    await sleep(11_000) // повне вікно p99 (300 тіків = 10 с)
    const baseline = await tickP99('r-dogfight')
    const rejectedBefore = await metric('conter_ws_rejections_total', 'reason="bad_shape"')

    // нападник: щомілісекунди кадр сміття; закрили — одразу перепідключається і продовжує
    let sent = 0
    let connections = 0
    let attacking = true
    const attack = async (): Promise<void> => {
      while (attacking) {
        connections++
        const ws = new WebSocket(WS)
        await new Promise<void>((resolve) => {
          ws.once('open', () => {
            // пачка одразу після підключення: поки сервер обробить перший кадр і закриє, летять ще 30
            for (let i = 0; i < 30; i++) {
              ws.send(Buffer.from([0xde, 0xad, 0xbe, 0xef, sent & 255]))
              sent++
            }
            const t = setInterval(() => {
              if (ws.readyState !== ws.OPEN) return
              ws.send(Buffer.from([0xde, 0xad, 0xbe, 0xef, sent & 255]))
              sent++
            }, 1)
            ws.once('close', () => {
              clearInterval(t)
              resolve()
            })
          })
          ws.once('error', () => resolve())
        })
      }
    }
    const attackers = [attack(), attack(), attack()] // три потоки, щоб сумарно вийти за 1000 кадрів/с
    const floodStart = performance.now()
    await sleep(11_000)
    attacking = false
    const floodSec = (performance.now() - floodStart) / 1000
    const during = await tickP99('r-dogfight')
    const rejectedAfter = await metric('conter_ws_rejections_total', 'reason="bad_shape"')
    await Promise.race([Promise.all(attackers), sleep(3000)])
    const stillOpen = victims.filter((v) => v.ws.readyState === v.ws.OPEN).length
    report.garbageFlood = {
      framesSent: sent,
      framesPerSec: Math.round(sent / floodSec),
      attackerConnections: connections,
      rejectedBadShape: rejectedAfter - rejectedBefore,
      otherRoomTickP99Ms: { baseline, duringFlood: during },
      otherRoomPlayersStillConnected: `${stillOpen}/${victims.length}`,
    }
    victims.forEach(stop)
  }
} finally {
  const exited = new Promise((r) => server.once('exit', r))
  server.send?.('shutdown')
  await Promise.race([exited, sleep(6000)])
  if (server.exitCode === null) server.kill()
}

console.log(JSON.stringify(report, null, 2))
const out = join(import.meta.dirname, '../../docs/lab-08')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'chaos.json'), JSON.stringify(report, null, 2) + '\n')
