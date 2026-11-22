import { Transform, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Room, RoomLogEvent } from '../rooms.ts'

// Перетворювач в об'єктному режимі: на вхід — об'єкти-події, на вихід — рядки NDJSON.
export function toNdjson(): Transform {
  return new Transform({
    writableObjectMode: true, // приймаємо об'єкти
    readableObjectMode: false, // віддаємо рядки
    transform(event: unknown, _encoding, callback) {
      try {
        callback(null, JSON.stringify(event) + '\n')
      } catch (e: unknown) {
        callback(e instanceof Error ? e : new Error(String(e))) // помилка піде в pipeline, а не впаде процес
      }
    },
  })
}

export function logFileName(roomId: string, date = new Date()): string {
  return `${roomId}-${date.toISOString().replace(/[:.]/g, '-')}.ndjson`
}

// Події кімнати як асинхронна послідовність, що закінчується на 'close'.
// (У Lab 4 тут був events.on(room, 'event') — але він повертає any[]; Lab 6 вимагає нуль any,
//  тож пишемо свою маленьку чергу з правильним типом.)
async function* roomEvents(room: Room): AsyncGenerator<RoomLogEvent> {
  const queue: RoomLogEvent[] = []
  let closed = false
  let wake: (() => void) | null = null
  const onEvent = (e: RoomLogEvent): void => {
    queue.push(e)
    wake?.()
  }
  const onClose = (): void => {
    closed = true
    wake?.()
  }
  room.on('event', onEvent)
  room.once('close', onClose)
  try {
    for (;;) {
      const next = queue.shift()
      if (next) yield next
      else if (closed)
        return // усе, що прийшло до close, уже віддано
      else await new Promise<void>((resolve) => (wake = resolve))
      wake = null
    }
  } finally {
    room.off('event', onEvent)
    room.off('close', onClose)
  }
}

export interface MatchLog {
  readonly file: string
  readonly done: Promise<void> // виконається, коли все записано на диск
}

// Лог матчу кімнати: room 'event' → Transform → файл, усе з'єднано через pipeline
// (backpressure і помилки). Файл відкривається лише при ПЕРШІЙ події.
export async function createMatchLog(
  room: Room,
  { dir, onError }: { dir: string; onError?: (e: unknown) => void },
): Promise<MatchLog> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, logFileName(room.id))
  const events = roomEvents(room)

  const done = (async () => {
    const first = await events.next()
    if (first.done) return // порожня кімната — порожнього файлу не буде
    const source = Readable.from(
      (async function* () {
        yield first.value
        yield* events
      })(),
    )
    await pipeline(source, toNdjson(), createWriteStream(file, { flags: 'a' }))
  })().catch((e: unknown) => onError?.(e))

  return { file, done }
}
