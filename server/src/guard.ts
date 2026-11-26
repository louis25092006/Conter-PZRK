import type { IncomingMessage } from 'node:http'

// Lab 8, M2: перевірки ще ДО відкриття WebSocket (ws: verifyClient) — відмова на етапі HTTP-рукостискання.
//
// 1) Origin. CORS на WebSocket не поширюється: сторінка БУДЬ-ЯКОГО сайту може зробити
//    new WebSocket('wss://наш-сервер/ws'), і браузер відкриє його від імені відвідувача.
//    Але браузер завжди додає заголовок Origin, і підробити його зі сторінки неможливо —
//    тож пускаємо лише Origin зі списку ALLOWED_ORIGINS. З'єднання БЕЗ Origin (не браузер:
//    load-test, net-harness) пропускаємо: такий клієнт однаково може підставити будь-що,
//    від нього захищають інші ліміти (на IP, на частоту, на розмір).
// 2) Скільки з'єднань з однієї IP (MAX_CONNECTIONS_PER_IP). За проксі хостингу справжня IP —
//    перша в X-Forwarded-For (TRUST_PROXY=true), інакше там можна написати що завгодно.

export interface GuardOptions {
  readonly allowedOrigins: readonly string[]
  readonly maxConnectionsPerIp: number
  readonly trustProxy: boolean
}

export type GuardVerdict =
  | { readonly ok: true; readonly ip: string }
  | {
      readonly ok: false
      readonly status: 403 | 429
      readonly reason: 'origin' | 'ip_limit'
      readonly ip: string
    }

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for']
    const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim()
    if (first) return first
  }
  return req.socket.remoteAddress ?? 'unknown'
}

export function createGuard(opts: GuardOptions) {
  const perIp = new Map<string, number>()
  const anyOrigin = opts.allowedOrigins.includes('*')

  function check(req: IncomingMessage): GuardVerdict {
    const ip = clientIp(req, opts.trustProxy)
    const origin = req.headers.origin
    if (origin !== undefined && !anyOrigin && !opts.allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
      return { ok: false, status: 403, reason: 'origin', ip }
    }
    if ((perIp.get(ip) ?? 0) >= opts.maxConnectionsPerIp)
      return { ok: false, status: 429, reason: 'ip_limit', ip }
    return { ok: true, ip }
  }

  return {
    check,
    // облік відкритих з'єднань: +1 на connection, −1 на close
    opened(ip: string): void {
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1)
    },
    closed(ip: string): void {
      const n = (perIp.get(ip) ?? 1) - 1
      if (n <= 0) perIp.delete(ip)
      else perIp.set(ip, n)
    },
    get trackedIps(): number {
      return perIp.size
    },
  }
}
export type Guard = ReturnType<typeof createGuard>
