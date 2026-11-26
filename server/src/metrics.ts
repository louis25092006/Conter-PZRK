import { Registry, Counter, Gauge, collectDefaultMetrics } from 'prom-client'
import { performance } from 'node:perf_hooks'
import { CLOSE } from '@conter/shared/protocol.ts'

// Lab 8: метрики у форматі Prometheus на GET /metrics (prom-client).
// Лічильники (Counter) лише ростуть — швидкість «за секунду» рахує той, хто їх читає:
//   rate(conter_messages_in_total[1m])  → повідомлень/с
// Датчики (Gauge) — поточне значення; їх рахуємо в момент запиту (collect), а не щокадру.

export interface LiveStats {
  readonly players: number // людей у кімнатах
  readonly bots: number
  readonly rooms: number
  readonly matches: number // кімнат, де зараз іде матч
  readonly connections: number // відкритих WebSocket
  readonly tickP99Ms: number // найгірший p99 тіку серед матчів за останні ~10 с
}

export interface Metrics {
  readonly registry: Registry
  messageIn(bytes: number): void
  messageOut(bytes: number): void
  rejected(reason: string): void
  // причина за кодом закриття: 4002 → "bad_shape", 4005 → "rate_limit"…
  rejectedByCode(code: number): void
}

const REASON_BY_CODE = new Map<number, string>(
  Object.entries(CLOSE).map(([name, code]): [number, string] => [code, name.toLowerCase()]),
)

export function createMetrics(live: () => LiveStats): Metrics {
  const registry = new Registry()
  registry.setDefaultLabels({ service: 'conter-server' })
  collectDefaultMetrics({ register: registry }) // RSS, heap, GC, лаг циклу подій…

  const messagesIn = new Counter({
    name: 'conter_messages_in_total',
    help: 'WebSocket messages received',
    registers: [registry],
  })
  const messagesOut = new Counter({
    name: 'conter_messages_out_total',
    help: 'WebSocket messages sent',
    registers: [registry],
  })
  const bytesIn = new Counter({
    name: 'conter_bytes_in_total',
    help: 'WebSocket bytes received',
    registers: [registry],
  })
  const bytesOut = new Counter({
    name: 'conter_bytes_out_total',
    help: 'WebSocket bytes sent',
    registers: [registry],
  })
  const rejections = new Counter({
    name: 'conter_ws_rejections_total',
    help: 'Connections refused or closed by the server, by reason',
    labelNames: ['reason'],
    registers: [registry],
  })

  const gauge = (name: string, help: string, read: (s: LiveStats) => number): void => {
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        this.set(read(live()))
      },
    })
  }
  gauge('conter_players', 'Human players in rooms', (s) => s.players)
  gauge('conter_bots', 'Server-side bots in rooms', (s) => s.bots)
  gauge('conter_rooms', 'Rooms on the server', (s) => s.rooms)
  gauge('conter_matches_running', 'Rooms with a running match', (s) => s.matches)
  gauge('conter_ws_connections', 'Open WebSocket connections', (s) => s.connections)
  gauge(
    'conter_tick_duration_p99_ms',
    'Worst match tick duration p99 over the last ~10 s',
    (s) => s.tickP99Ms,
  )

  // ELU (event loop utilization): частка часу, коли цикл подій був зайнятий, з минулого запиту
  let lastElu = performance.eventLoopUtilization()
  new Gauge({
    name: 'conter_event_loop_utilization',
    help: 'Event loop utilization (0..1) since the previous scrape',
    registers: [registry],
    collect() {
      const elu = performance.eventLoopUtilization(lastElu)
      lastElu = performance.eventLoopUtilization()
      this.set(+elu.utilization.toFixed(4))
    },
  })

  return {
    registry,
    messageIn(bytes) {
      messagesIn.inc()
      bytesIn.inc(bytes)
    },
    messageOut(bytes) {
      messagesOut.inc()
      bytesOut.inc(bytes)
    },
    rejected(reason) {
      rejections.inc({ reason })
    },
    rejectedByCode(code) {
      rejections.inc({ reason: REASON_BY_CODE.get(code) ?? `code_${code}` })
    },
  }
}
