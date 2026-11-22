import { Transform, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { on } from 'node:events'
import { join } from 'node:path'

// Перетворювач у об'єктному режимі: на вхід — об'єкти-події, на вихід — рядки NDJSON
// (один JSON-об'єкт на рядок). Такий файл можна дописувати і читати по рядку,
// не завантажуючи весь у пам'ять.
export function toNdjson() {
  return new Transform({
    writableObjectMode: true, // приймаємо об'єкти
    readableObjectMode: false, // віддаємо байти/рядки
    transform(event, _encoding, callback) {
      try {
        callback(null, JSON.stringify(event) + '\n')
      } catch (err) {
        callback(err) // напр. циклічне посилання — помилка піде в pipeline, а не впаде процес
      }
    },
  })
}

export function logFileName(roomId, date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, '-')
  return `${roomId}-${stamp}.ndjson`
}

// Лог матчу кімнати: room 'event' → Transform → файл.
//   Readable.from(on(room, 'event'))  — події EventEmitter як асинхронний потік;
//   close: ['close'] — коли кімната закривається, ітерація закінчується і потік чесно завершується;
//   pipeline        — з'єднує все, передає backpressure і помилки, закриває файл.
// Повертає { file, done }: done — проміс, що виконається, коли все записано на диск.
export async function createMatchLog(room, { dir, onError } = {}) {
  await mkdir(dir, { recursive: true })
  const file = join(dir, logFileName(room.id))
  const events = on(room, 'event', { close: ['close'] })[Symbol.asyncIterator]()

  const done = (async () => {
    // Файл відкриваємо лише тоді, коли сталася перша подія: порожня кімната
    // (або сервер, який вбили до першого гравця) не лишає порожніх файлів.
    const first = await events.next()
    if (first.done) return
    // on() віддає масив аргументів події — беремо перший
    const source = Readable.from(
      (async function* () {
        yield first.value[0]
        for (let next = await events.next(); !next.done; next = await events.next()) yield next.value[0]
      })(),
    )
    await pipeline(source, toNdjson(), createWriteStream(file, { flags: 'a' }))
  })().catch((err) => onError?.(err))

  return { file, done }
}
