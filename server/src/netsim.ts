import type { NetsimConfig } from '@conter/shared/protocol.ts'
import type { Codec } from '@conter/shared/codec/index.ts'

// Імітатор поганої мережі для одного з'єднання (Lab 5, розділ 7).
//   lag    — додаткова затримка ТУДИ-І-НАЗАД (мс), по lag/2 у кожен бік;
//   jitter — випадкова добавка 0..jitter мс до кожного повідомлення;
//   drop   — частка ЗНІМКІВ, що "губляться" (0..0.5). Команди, чат і т.п. не губимо (TCP).
// Порядок повідомлень зберігається (як у TCP): кожне наступне не раніше попереднього.

export interface Link {
  readonly config: Readonly<NetsimConfig>
  readonly stats: { dropped: number }
  set(cfg: NetsimConfig): void
  out(send: () => void, opts?: { droppable?: boolean }): void
  in(handle: () => void): void
}

const clamp = (v: number, min: number, max: number): number =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min

export function createLink(
  { lag = 0, jitter = 0, drop = 0 }: Partial<NetsimConfig> = {},
  random = Math.random,
): Link {
  const cfg: NetsimConfig = {
    lag: clamp(lag, 0, 1000),
    jitter: clamp(jitter, 0, 500),
    drop: clamp(drop, 0, 0.5),
  }
  const stats = { dropped: 0 }
  const delay = (): number => cfg.lag / 2 + random() * cfg.jitter
  const active = (): boolean => cfg.lag > 0 || cfg.jitter > 0

  // Черга FIFO з ОДНИМ таймером на кожен напрямок (окремі setTimeout міняли повідомлення
  // місцями через округлення до мс — і передбачення розходилось на крок; див. README Lab 5).
  function createQueue(): (fn: () => void) => void {
    const items: { at: number; fn: () => void }[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastAt = 0
    function pump(): void {
      timer = null
      const now = performance.now()
      for (let head = items[0]; head && head.at <= now + 0.5; head = items[0]) {
        items.shift()
        head.fn()
      }
      const next = items[0]
      if (next) timer = setTimeout(pump, Math.max(0, next.at - now))
    }
    return (fn) => {
      const now = performance.now()
      lastAt = Math.max(lastAt, now + delay()) // кожне наступне — не раніше попереднього
      items.push({ at: lastAt, fn })
      if (!timer) timer = setTimeout(pump, Math.max(0, lastAt - now))
    }
  }
  const outQueue = createQueue()
  const inQueue = createQueue()

  return {
    config: cfg,
    stats,
    set(next) {
      cfg.lag = clamp(next.lag, 0, 1000)
      cfg.jitter = clamp(next.jitter, 0, 500)
      cfg.drop = clamp(next.drop, 0, 0.5)
    },
    out(send, { droppable = false } = {}) {
      if (droppable && cfg.drop > 0 && random() < cfg.drop) {
        stats.dropped++
        return
      }
      if (!active()) return send()
      outQueue(send)
    },
    in(handle) {
      if (!active()) return handle()
      inQueue(handle)
    },
  }
}

// параметри з адреси WebSocket: /ws?lag=100&jitter=30&drop=0.02&codec=binary
export function parseNetParams(url: string): NetsimConfig & { codec: Codec['name'] } {
  const q = new URL(url, 'http://localhost').searchParams
  return {
    lag: Number(q.get('lag') ?? 0),
    jitter: Number(q.get('jitter') ?? 0),
    drop: Number(q.get('drop') ?? 0),
    codec: q.get('codec') === 'json' ? 'json' : 'binary',
  }
}
