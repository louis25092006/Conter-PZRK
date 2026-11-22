import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, basename } from 'node:path'

// Читає NDJSON-файл ПО РЯДКУ і віддає розібрані записи.
// Тип — unknown: файл прийшов з диска, тож довіряти його формі без перевірки не можна.
export async function* readReplay(file: string): AsyncGenerator<unknown> {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  let n = 0
  for await (const line of lines) {
    n++
    if (!line.trim()) continue
    try {
      const entry: unknown = JSON.parse(line)
      yield entry
    } catch {
      throw new Error(`${basename(file)}: corrupt line ${n}`)
    }
  }
}

// Безпечне ім'я файлу реплею: лише літери/цифри/._- і розширення .ndjson. Ніяких "../".
export const REPLAY_ID = /^[\w-]+(\.[\w-]+)*\.ndjson$/

export interface ReplayInfo {
  readonly id: string
  readonly bytes: number
  readonly modified: string
}

const isErrnoException = (e: unknown): e is NodeJS.ErrnoException => e instanceof Error && 'code' in e

export async function listReplays(dir: string): Promise<ReplayInfo[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (e: unknown) {
    if (isErrnoException(e) && e.code === 'ENOENT') return []
    throw e
  }
  const replays: ReplayInfo[] = []
  for (const id of names.filter((n) => REPLAY_ID.test(n))) {
    const s = await stat(join(dir, id))
    replays.push({ id, bytes: s.size, modified: s.mtime.toISOString() })
  }
  return replays.sort((a, b) => b.modified.localeCompare(a.modified))
}
