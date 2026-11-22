import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, basename } from 'node:path'

// Читає NDJSON-файл ПО РЯДКУ і віддає розібрані події.
// Пам'ять не залежить від розміру файлу: у кожен момент у RAM — шматок файлу і один рядок.
export async function* readReplay(file) {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  let n = 0
  for await (const line of lines) {
    n++
    if (!line.trim()) continue
    try {
      yield JSON.parse(line)
    } catch {
      throw new Error(`${basename(file)}: corrupt line ${n}`)
    }
  }
}

// Безпечне ім'я файлу реплею: лише літери/цифри/._- і розширення .ndjson.
// Ніяких "../" — інакше через /api/replays/..%2F..%2Fsecret можна було б читати будь-що.
export const REPLAY_ID = /^[\w-]+(\.[\w-]+)*\.ndjson$/

export async function listReplays(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const replays = []
  for (const id of names.filter((n) => REPLAY_ID.test(n))) {
    const s = await stat(join(dir, id))
    replays.push({ id, bytes: s.size, modified: s.mtime.toISOString() })
  }
  return replays.sort((a, b) => b.modified.localeCompare(a.modified))
}
