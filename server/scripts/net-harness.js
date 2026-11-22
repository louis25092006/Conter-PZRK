// Справжній клієнтський код (client/src/net/net-game.js) у Node — без браузера.
// Node 22+ має вбудований WebSocket, а NetGame не залежить від DOM, тож можна точно
// поміряти передбачення/звірку з будь-якою імітацією мережі.
//
//   node scripts/net-harness.js [--lag 100 --jitter 30 --drop 0.02] [--codec json] [--nondet] [--seconds 8]
//
// Сценарій: літак у відкритому небі (арена Dogfight, без астероїдів) літає з поворотами.
// Виводимо поправки звірки (px) і мережеву статистику — це числа для README.

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { NetGame } from '../../client/src/net/net-game.js'
import { debug } from '../../shared/src/sim/ship-physics.js'

const { values: args } = parseArgs({
  options: {
    lag: { type: 'string', default: '100' },
    jitter: { type: 'string', default: '30' },
    drop: { type: 'string', default: '0.02' },
    codec: { type: 'string', default: 'binary' },
    seconds: { type: 'string', default: '8' },
    nondet: { type: 'boolean', default: false },
    nopredict: { type: 'boolean', default: false },
    room: { type: 'string', default: 'r-training' },
    port: { type: 'string', default: '3103' },
  },
})

const PORT = Number(args.port)
const server = spawn(process.execPath, ['src/index.js'], {
  cwd: join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), QUIET: 'true' },
  stdio: 'inherit',
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  await sleep(700)
  if (args.nondet) debug.breakDeterminism = true // ламаємо детермінізм ЛИШЕ в клієнті (сервер — інший процес)
  const game = new NetGame({
    room: { id: args.room, arenaConfig: {} },
    name: 'harness',
    net: {
      url: `ws://127.0.0.1:${PORT}/ws`,
      codec: args.codec,
      lag: Number(args.lag),
      jitter: Number(args.jitter),
      drop: Number(args.drop),
      predict: !args.nopredict,
    },
  })
  while (!game.you) await sleep(20)

  // ігровий цикл як у браузері: кроків = минулий час × 60
  async function fly(seconds, command) {
    const t0 = performance.now()
    let done = 0
    while (done < seconds * 60) {
      const target = Math.floor((performance.now() - t0) / (1000 / 60))
      while (done < target) game.step(command(done++))
      await sleep(4)
    }
  }
  await fly(1, () => ({ turn: 0, thrust: false, fire: false }))
  game.stats.corrections.length = 0

  // реакція: від першої команди "газ" до знімка, де сервер уже рухає літак.
  // З передбаченням гравець бачить рух одразу (0 мс); без нього — лише через цей час.
  let thrustAt = 0
  let reactionMs = null
  const startSpeed = Math.hypot(game.myData.vx, game.myData.vy)
  game.conn.addEventListener('binary', () =>
    queueMicrotask(() => {
      if (thrustAt && reactionMs === null && Math.hypot(game.myData.vx, game.myData.vy) > startSpeed + 1) {
        reactionMs = performance.now() - thrustAt
      }
    }),
  )
  let maxPending = 0
  let sumPending = 0
  let n = 0
  const probe = setInterval(() => {
    maxPending = Math.max(maxPending, game.stats.pending)
    sumPending += game.stats.pending
    n++
  }, 50)
  await fly(Number(args.seconds), (k) => {
    if (k === 0) thrustAt = performance.now()
    return { turn: k % 90 < 30 ? 1 : 0, thrust: true, fire: false }
  })
  clearInterval(probe)

  const c = [...game.stats.corrections].sort((a, b) => a - b)
  const pct = (p) => c[Math.min(c.length - 1, Math.floor(c.length * p))] ?? 0
  const s = game.stats
  console.log(
    JSON.stringify(
      {
        net: `${args.lag}±${args.jitter} ms, drop ${args.drop * 100}%`,
        codec: args.codec,
        prediction: !args.nopredict,
        determinismBroken: args.nondet,
        rttMs: Math.round(s.rtt),
        serverConfirmsThrustAfterMs: Math.round(reactionMs),
        playerSeesThrustAfterMs: args.nopredict ? Math.round(reactionMs) : 0,
        pendingAvg: +(sumPending / n).toFixed(1),
        pendingMax: maxPending,
        corrections: {
          snapshots: c.length,
          zero: c.filter((x) => x < 0.01).length,
          median: +pct(0.5).toFixed(3),
          p95: +pct(0.95).toFixed(2),
          max: +(c.at(-1) ?? 0).toFixed(2), // без передбачення звіряти нічого — список порожній
        },
        downKBs: +(s.bytesInPerSec / 1024).toFixed(2),
        upKBs: +(s.bytesOutPerSec / 1024).toFixed(2),
        snapshotBytes: s.lastSnapshotBytes,
      },
      null,
      2,
    ),
  )
  game.close()
} finally {
  server.kill()
}
