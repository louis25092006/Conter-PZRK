// Таблиця M4: JSON проти бінарного DataView при 30 Гц і 4 гравцях.
//   node scripts/codec-bench.ts
// Справжня симуляція (арена Classic): 4 літаки гравців літають і стріляють як боти,
// поруч вороги, астероїди, кулі. Кожен тік (2 кроки) знімаємо знімок і кодуємо обома кодеками.

import { readFileSync } from 'node:fs'
import { World } from '@conter/shared/sim/world.ts'
import { Ship } from '@conter/shared/sim/ship.ts'
import { populateArena } from '@conter/shared/sim/spawner.ts'
import { ARENA_SIZE } from '@conter/shared/sim/arena.ts'
import { SIM_DT } from '@conter/shared/sim/ship-physics.ts'
import { snapshotEntities, collectEvents, makeSnapshot } from '@conter/shared/net/snapshot.ts'
import { jsonCodec, binaryCodec, byteSize, type Codec } from '@conter/shared/codec/index.ts'
import { ArenasSchema } from '@conter/shared/arena-config.ts'
import { toSeq, toTick } from '@conter/shared/types.ts'
import type { InputMsg, Snapshot } from '@conter/shared/protocol.ts'
import type { Command } from '@conter/shared/sim/ship-physics.ts'
import type { EntityId } from '@conter/shared/types.ts'
import { botCommand } from '../../client/src/game/commands.ts'

const arenas = ArenasSchema.parse(
  JSON.parse(readFileSync(new URL('../../client/public/assets/arenas.json', import.meta.url), 'utf8')),
)
const classic = arenas.classic
if (!classic) throw new Error('arenas.json: no "classic" arena')
const world = new World({ ...ARENA_SIZE, arena: { ...classic, enemiesBase: 3 } })
const players = [200, 600, 1000, 1400].map((x) => world.spawn(new Ship({ x, y: 450 })))
populateArena(world)
const events = collectEvents(world)

const TICKS = 30 * 60 // хвилина гри
type CodecName = Codec['name']
const sizes: Record<CodecName, number[]> = { json: [], binary: [] }
const snaps: Snapshot[] = []
let step = 0
for (let t = 0; t < TICKS; t++) {
  for (let i = 0; i < 2; i++) {
    const targets = [...world]
      .filter((e) => e.alive && ((e.kind === 'ship' && e.team === 'enemy') || e.kind === 'asteroid'))
      .map((e) => e.pos)
    const inputs = new Map<EntityId, Command>(
      players.map((p) => [p.id, { ...botCommand(p.motionState(), targets, step), seq: toSeq(step + 1) }]),
    )
    world.step(SIM_DT, inputs)
    step++
  }
  const snap = makeSnapshot({
    tick: toTick(t),
    ack: toSeq(step),
    you: players[0]?.id ?? null,
    entities: snapshotEntities(world),
    events: events.drain(),
  })
  sizes.json.push(byteSize(jsonCodec.encodeSnapshot(snap)))
  sizes.binary.push(byteSize(binaryCodec.encodeSnapshot(snap)))
  if (t % 10 === 0) snaps.push(snap)
}

function timeIt(codec: Codec): number {
  const pick = (i: number): Snapshot => {
    const s = snaps[i % snaps.length]
    if (!s) throw new Error('no snapshots')
    return s
  }
  // розігрів (JIT), потім заміряємо
  for (let i = 0; i < 2000; i++) codec.decodeSnapshot(codec.encodeSnapshot(pick(i)))
  const N = 20000
  const t0 = performance.now()
  for (let i = 0; i < N; i++) codec.decodeSnapshot(codec.encodeSnapshot(pick(i)))
  return ((performance.now() - t0) * 1000) / N
}

const avg = (a: readonly number[]): number => a.reduce((s, x) => s + x, 0) / a.length
const input: InputMsg = { type: 'input', seq: toSeq(123456), turn: -1, thrust: true, fire: false }
const inputBytes: Record<CodecName, number> = {
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
const names: CodecName[] = ['json', 'binary']
for (const name of names) {
  const codec = name === 'json' ? jsonCodec : binaryCodec
  const b = avg(sizes[name])
  console.log(
    `| ${name === 'json' ? 'JSON' : 'Binary (`DataView`)'} | ${b.toFixed(0)} / ${Math.max(...sizes[name])} | ${((b * 30) / 1024).toFixed(2)} | ${((inputBytes[name] * 60) / 1024).toFixed(2)} | ${timeIt(codec).toFixed(1)} |`,
  )
}
console.log(`\nКоманда гравця: JSON ${inputBytes.json} B, binary ${inputBytes.binary} B (60 разів/с).`)
console.log(`Бінарний знімок менший у ${(avg(sizes.json) / avg(sizes.binary)).toFixed(1)} раза.`)
console.log('(Без накладних витрат WebSocket-кадру: +2…4 байти заголовка на повідомлення.)')
