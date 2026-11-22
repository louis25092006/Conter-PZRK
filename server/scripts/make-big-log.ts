// Генерує синтетичний лог матчу ~200 МБ: node scripts/make-big-log.js [MB]
// Сам генератор теж пише через pipeline — тому пам'ять не росте, хоч файл і великий.
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { toNdjson } from '../src/log/matchlog.ts'

const targetMB = Number(process.argv[2] ?? 200)
const dir = join(import.meta.dirname, '..', 'logs')
await mkdir(dir, { recursive: true })
const file = join(dir, `synthetic-${targetMB}mb.ndjson`)

const names = ['Ira', 'Bob', 'Olya', 'Max', 'Taras', 'Sofia']
let bytes = 0
function* events() {
  for (let i = 0; bytes < targetMB * 1048576; i++) {
    const player = { id: `p${i % 6}`, name: names[i % 6] }
    const e =
      i % 5 === 0
        ? { t: 1700000000000 + i * 16, room: 'synthetic', type: 'chat', player, text: `повідомлення №${i}` }
        : {
            t: 1700000000000 + i * 16,
            room: 'synthetic',
            type: 'move',
            player,
            x: i % 1024,
            y: (i * 7) % 768,
          }
    bytes += JSON.stringify(e).length + 1
    yield e
  }
}

const t0 = performance.now()
await pipeline(Readable.from(events()), toNdjson(), createWriteStream(file))
const rss = (process.memoryUsage().rss / 1048576).toFixed(0)
console.log(
  `${file}: ~${targetMB} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s, peak-ish rss ${rss} MB`,
)
