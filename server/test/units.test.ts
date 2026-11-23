import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLOSE, type PlayerInfo } from '@conter/shared/protocol.ts'
import { toEntityId } from '@conter/shared/types.ts'
import { Room, RoomManager, RoomsLimitError } from '../src/rooms.ts'
import { createTokenBucket } from '../src/rate-limit.ts'
import { createMatchLog } from '../src/log/matchlog.ts'
import { readReplay } from '../src/log/replay.ts'
import { loadConfig } from '../src/config.ts'
import { loadArenas } from '../src/app.ts'
import { createSender, type SendTarget } from '../src/ws.ts'

// (Тести протоколу переїхали в shared/test — протокол тепер живе там.)

const player = (id: string, name = id.toUpperCase()): PlayerInfo => ({ id, name, shipId: toEntityId(1) })

// ---------- кімнати ----------

test('Room: події join/leave/chat/empty', () => {
  const room = new Room({ name: 'test', maxPlayers: 2 })
  const seen: string[] = []
  room.on('join', () => seen.push('join'))
  room.on('leave', () => seen.push('leave'))
  room.on('chat', () => seen.push('chat'))
  room.on('empty', () => seen.push('empty'))
  room.join(player('a'))
  room.chat('a', 'hi')
  room.chat('ghost', 'не в кімнаті — ігнор')
  room.leave('a')
  assert.deepEqual(seen, ['join', 'chat', 'leave', 'empty'])
})

test('Room: заповнена кімната не пускає', () => {
  const room = new Room({ name: 't', maxPlayers: 1 })
  room.join(player('a'))
  assert.throws(() => room.join(player('b')), /full/)
})

test('RoomManager: ліміт кімнат і видалення порожніх (крім persistent)', () => {
  const m = new RoomManager({ maxRooms: 2 })
  const keep = m.create({ name: 'keep', persistent: true })
  const temp = m.create({ name: 'temp' })
  assert.throws(() => m.create({ name: 'third' }), RoomsLimitError)
  for (const room of [keep, temp]) {
    room.join(player('p'))
    room.leave('p')
  }
  assert.equal(m.get(temp.id), undefined) // спорожніла — видалена
  assert.equal(m.get(keep.id), keep) // стандартна — лишилась
})

// ---------- rate limit ----------

test('token bucket: сплеск до burst, далі perSec', () => {
  let now = 0
  const bucket = createTokenBucket({ perSec: 10, burst: 5, now: () => now })
  const takes = (): number => Array.from({ length: 8 }, () => bucket.take()).filter(Boolean).length
  assert.equal(takes(), 5) // одразу — лише burst
  now += 300 // за 0.3 с накапало 3 жетони
  assert.equal(takes(), 3)
})

// ---------- лог матчу ----------

test('match log: події кімнати → NDJSON на диску → назад через readReplay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conter-log-'))
  try {
    const room = new Room({ id: 'logtest', name: 'Log test' })
    const { file, done } = await createMatchLog(room, { dir })
    room.join(player('a', 'Ira'))
    room.chat('a', 'привіт 👋')
    room.leave('a')
    room.close() // → pipeline завершується, файл закривається
    await done

    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 4)
    const types: unknown[] = []
    for await (const e of readReplay(file))
      types.push(typeof e === 'object' && e !== null && 'type' in e ? e.type : null)
    assert.deepEqual(types, ['join', 'chat', 'leave', 'close'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('match log: порожня кімната не лишає файлу', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conter-log-'))
  try {
    const room = new Room({ id: 'empty', name: 'nobody' })
    const { file, done } = await createMatchLog(room, { dir })
    room.close()
    await done
    await assert.rejects(readFile(file), { code: 'ENOENT' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- конфіг (zod) ----------

test('config: погане значення валить старт з поясненням, добрі — з типами', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/)
  assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/)
  assert.throws(() => loadConfig({ DEMO_ENDPOINTS: 'maybe' }), /DEMO_ENDPOINTS/)
  const c = loadConfig({ PORT: '4000', DEMO_ENDPOINTS: 'yes', PATH: 'ignored' })
  assert.equal(c.port, 4000) // рядок з env перетворено на число
  assert.equal(c.demoEndpoints, true)
  assert.equal(loadConfig({}).maxRooms, 20) // значення за замовчуванням
})

test('arenas.json проходить zod-схему; зіпсований — зрозуміла помилка', async () => {
  const arenas = loadArenas(loadConfig({}).arenasFile)
  assert.ok(arenas.classic && arenas.dogfight)
  const dir = await mkdtemp(join(tmpdir(), 'conter-arenas-'))
  try {
    const bad = join(dir, 'arenas.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(bad, JSON.stringify({ classic: { name: 'x', homingChance: 5 } }))
    assert.throws(() => loadArenas(bad), /Invalid/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- повільний клієнт ----------

test('slow client: чат пропускаємо, критичне шлемо, зовсім повільного відключаємо', () => {
  const counters = { dropped: 0, slowClosed: 0 }
  const send = createSender({ slowClientBytes: 1000, counters })
  const fake = (bufferedAmount: number) => {
    const sent: (string | ArrayBuffer)[] = []
    let closedWith: number | null = null
    const target: SendTarget = {
      readyState: 1, // OPEN
      bufferedAmount,
      send: (data) => void sent.push(data),
      close: (code) => void (closedWith = code),
    }
    return { target, sent, closedWith: () => closedWith }
  }
  const fast = fake(0)
  assert.equal(send(fast.target, { type: 'chat' }, { critical: false }), 'sent')
  const lagging = fake(2000)
  assert.equal(send(lagging.target, { type: 'chat' }, { critical: false }), 'dropped')
  assert.equal(send(lagging.target, { type: 'roster' }), 'sent') // склад кімнати — критичне, шлемо
  const dead = fake(5000)
  assert.equal(send(dead.target, { type: 'roster' }), 'closed')
  assert.equal(dead.closedWith(), CLOSE.SLOW_CLIENT)
  assert.deepEqual(counters, { dropped: 1, slowClosed: 1 })
})
