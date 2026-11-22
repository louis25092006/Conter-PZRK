import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validate, CLOSE } from '../src/protocol.js'
import { Room, RoomManager } from '../src/rooms.js'
import { createTokenBucket } from '../src/rate-limit.js'
import { createMatchLog } from '../src/log/matchlog.js'
import { readReplay } from '../src/log/replay.js'
import { loadConfig } from '../src/config.js'

// ---------- протокол ----------

test('protocol: валідні повідомлення проходять', () => {
  assert.equal(validate(JSON.stringify({ type: 'join', v: 1, roomId: 'r1', name: 'Ira' })).ok, true)
  assert.equal(validate(JSON.stringify({ type: 'chat', text: 'привіт' })).ok, true)
})

test('protocol: кожен вид поганого повідомлення має свій код', () => {
  const code = (raw) => validate(raw).code
  assert.equal(code('{not json'), CLOSE.BAD_JSON)
  assert.equal(code('[1,2]'), CLOSE.BAD_SHAPE)
  assert.equal(code('{"no":"type"}'), CLOSE.BAD_SHAPE)
  assert.equal(code('{"type":"fly"}'), CLOSE.UNKNOWN_TYPE)
  assert.equal(code('{"type":"__proto__"}'), CLOSE.UNKNOWN_TYPE) // не дістанемось до прототипу
  assert.equal(code('{"type":"join","v":7,"roomId":"r","name":"a"}'), CLOSE.BAD_VERSION)
  assert.equal(code('{"type":"join","v":1,"roomId":"r","name":""}'), CLOSE.BAD_SHAPE)
  assert.equal(code(JSON.stringify({ type: 'chat', text: 'x'.repeat(201) })), CLOSE.BAD_SHAPE)
  assert.equal(code(JSON.stringify({ type: 'chat', text: 'x'.repeat(3000) })), CLOSE.TOO_BIG)
})

// ---------- кімнати ----------

test('Room: події join/leave/chat/empty', () => {
  const room = new Room({ name: 'test', maxPlayers: 2 })
  const seen = []
  for (const type of ['join', 'leave', 'chat', 'empty']) room.on(type, () => seen.push(type))
  room.join({ id: 'a', name: 'A' })
  room.chat('a', 'hi')
  room.chat('ghost', 'не в кімнаті — ігнор')
  room.leave('a')
  assert.deepEqual(seen, ['join', 'chat', 'leave', 'empty'])
})

test('Room: заповнена кімната не пускає', () => {
  const room = new Room({ name: 't', maxPlayers: 1 })
  room.join({ id: 'a', name: 'A' })
  assert.throws(() => room.join({ id: 'b', name: 'B' }), /full/)
})

test('RoomManager: ліміт кімнат і видалення порожніх (крім persistent)', () => {
  const m = new RoomManager({ maxRooms: 2 })
  const keep = m.create({ name: 'keep', persistent: true })
  const temp = m.create({ name: 'temp' })
  assert.throws(
    () => m.create({ name: 'third' }),
    (e) => e.code === 'ROOMS_LIMIT',
  )
  for (const room of [keep, temp]) {
    room.join({ id: 'p', name: 'P' })
    room.leave('p')
  }
  assert.equal(m.get(temp.id), undefined) // спорожніла — видалена
  assert.equal(m.get(keep.id), keep) // стандартна — лишилась
})

// ---------- rate limit ----------

test('token bucket: сплеск до burst, далі perSec', () => {
  let now = 0
  const bucket = createTokenBucket({ perSec: 10, burst: 5, now: () => now })
  const takes = () => Array.from({ length: 8 }, () => bucket.take()).filter(Boolean).length
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
    room.join({ id: 'a', name: 'Ira' })
    room.chat('a', 'привіт 👋')
    room.leave('a')
    room.close() // → pipeline завершується, файл закривається
    await done

    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 4)
    const events = []
    for await (const e of readReplay(file)) events.push(e.type)
    assert.deepEqual(events, ['join', 'chat', 'leave', 'close'])
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

// ---------- конфіг ----------

test('config: погане значення валить старт з поясненням', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT must be an integer/)
  assert.throws(() => loadConfig({ DEMO_ENDPOINTS: 'maybe' }), /DEMO_ENDPOINTS/)
  assert.equal(loadConfig({ PORT: '4000' }).port, 4000)
})

// ---------- повільний клієнт ----------

test('slow client: чат пропускаємо, критичне шлемо, зовсім повільного відключаємо', async () => {
  const { createSender } = await import('../src/ws.js')
  const counters = { dropped: 0, slowClosed: 0 }
  const send = createSender({ slowClientBytes: 1000, counters })
  const fake = (bufferedAmount) => ({
    readyState: 1, // OPEN
    bufferedAmount,
    sent: [],
    closedWith: null,
    send(data) {
      this.sent.push(data)
    },
    close(code) {
      this.closedWith = code
    },
  })
  const fast = fake(0)
  assert.equal(send(fast, { type: 'chat' }, { critical: false }), 'sent')
  const lagging = fake(2000)
  assert.equal(send(lagging, { type: 'chat' }, { critical: false }), 'dropped')
  assert.equal(send(lagging, { type: 'roster' }), 'sent') // склад кімнати — критичне, шлемо
  const dead = fake(5000)
  assert.equal(send(dead, { type: 'roster' }), 'closed')
  assert.equal(dead.closedWith, CLOSE.SLOW_CLIENT)
  assert.deepEqual(counters, { dropped: 1, slowClosed: 1 })
})
