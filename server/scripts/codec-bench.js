// Таблиця M4: JSON проти бінарного DataView при 30 Гц і 4 гравцях.
//   node scripts/codec-bench.js
// Справжня симуляція (арена Classic): 4 літаки гравців літають і стріляють як боти,
// поруч вороги, астероїди, кулі. Кожен тік (2 кроки) знімаємо знімок і кодуємо обома кодеками.

import { readFileSync } from 'node:fs'
import { World } from '@conter/shared/sim/world.js'
import { Ship } from '@conter/shared/sim/ship.js'
import { populateArena } from '@conter/shared/sim/spawner.js'
import { ARENA_SIZE } from '@conter/shared/sim/arena.js'
import { SIM_DT } from '@conter/shared/sim/ship-physics.js'
import { snapshotEntities, collectEvents, makeSnapshot } from '@conter/shared/net/snapshot.js'
import { jsonCodec, binaryCodec, byteSize } from '@conter/shared/codec/index.js'
import { botCommand } from '../../client/src/game/commands.js'

const arenas = JSON.parse(
  readFileSync(new URL('../../client/public/assets/arenas.json', import.meta.url), 'utf8'),
)
const world = new World({ ...ARENA_SIZE, arena: { ...arenas.classic, enemiesBase: 3 } })
const players = [200, 600, 1000, 1400].map((x) => world.spawn(new Ship({ x, y: 450 })))
populateArena(world)
const events = collectEvents(world)

const TICKS = 30 * 60 // хвилина гри
const sizes = { json: [], binary: [] }
const snaps = []
let step = 0
for (let t = 0; t < TICKS; t++) {
  for (let i = 0; i < 2; i++) {
    const targets = [...world]
      .filter((e) => e.alive && ((e.kind === 'ship' && e.team === 'enemy') || e.kind === 'asteroid'))
      .map((e) => e.pos)
    const inputs = new Map(
      players.map((p) => [p.id, { ...botCommand(p.motionState(), targets, step), seq: step + 1 }]),
    )
    world.step(SIM_DT, inputs)
    step++
  }
  const snap = makeSnapshot({
    tick: t,
    ack: step,
    you: players[0].id,
    entities: snapshotEntities(world),
    events: events.drain(),
  })
  sizes.json.push(byteSize(jsonCodec.encodeSnapshot(snap)))
  sizes.binary.push(byteSize(binaryCodec.encodeSnapshot(snap)))
  if (t % 10 === 0) snaps.push(snap)
}

function timeIt(codec) {
  // розігрів (JIT), потім заміряємо
  for (let i = 0; i < 2000; i++) codec.decodeSnapshot(codec.encodeSnapshot(snaps[i % snaps.length]))
  const N = 20000
  const t0 = performance.now()
  for (let i = 0; i < N; i++) codec.decodeSnapshot(codec.encodeSnapshot(snaps[i % snaps.length]))
  return ((performance.now() - t0) * 1000) / N
}

const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length
const input = { seq: 123456, turn: -1, thrust: true, fire: false }
const inputBytes = {
  json: byteSize(jsonCodec.encodeInput(input)),
  binary: byteSize(binaryCodec.encodeInput(input)),
}
const avgEntities = avg(snaps.map((s) => s.entities.length))

console.log(
  `Знімків: ${TICKS}, у середньому сутностей у знімку: ${avgEntities.toFixed(1)} (4 гравці + вороги + астероїди + кулі)\n`,
)
console.log(
  '| Codec | Bytes/snapshot (avg / max) | KB/s per client (down) | KB/s per client (up) | Encode+decode µs |',
)
console.log('|---|---|---|---|---|')
for (const name of ['json', 'binary']) {
  const codec = name === 'json' ? jsonCodec : binaryCodec
  const b = avg(sizes[name])
  console.log(
    `| ${name === 'json' ? 'JSON' : 'Binary (`DataView`)'} | ${b.toFixed(0)} / ${Math.max(...sizes[name])} | ${((b * 30) / 1024).toFixed(2)} | ${((inputBytes[name] * 60) / 1024).toFixed(2)} | ${timeIt(codec).toFixed(1)} |`,
  )
}
console.log(`\nКоманда гравця: JSON ${inputBytes.json} B, binary ${inputBytes.binary} B (60 разів/с).`)
console.log(`Бінарний знімок менший у ${(avg(sizes.json) / avg(sizes.binary)).toFixed(1)} раза.`)
console.log('(Без накладних витрат WebSocket-кадру: +2…4 байти заголовка на повідомлення.)')
