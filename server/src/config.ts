import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

// Уся конфігурація — зі змінних середовища (process.env), через zod-схему (Lab 6).
// Схема — це і перевірка (PORT=abc → зрозуміла помилка при старті), і значення за замовчуванням,
// і тип ServerConfig, виведений автоматично.

const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url))

// змінні середовища — завжди рядки; перетворюємо в число з перевіркою меж
const int = (def: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def)
const bool = (def: boolean) =>
  z
    .enum(['1', '0', 'true', 'false', 'yes', 'no'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === '1' || v === 'true' || v === 'yes')
const path = (def: string) =>
  z
    .string()
    .min(1)
    .default(def)
    .transform((p) => resolve(SERVER_ROOT, p))

// Lab 8: список дозволених Origin через кому; '*' — будь-який (лише для дослідів!)
const origins = (def: string) =>
  z
    .string()
    .default(def)
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    )
const DEV_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000'

export const ServerConfigSchema = z.object({
  PORT: int(3000, 0, 65535),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_DIR: path('logs'),
  CLIENT_DIST: path('../client/dist'),
  // параметри арен — той самий файл, що вантажить клієнт (одне джерело правди)
  ARENAS_FILE: path('../client/public/assets/arenas.json'),
  MAX_ROOMS: int(20, 1, 1000),
  MAX_PLAYERS_PER_ROOM: int(8, 1, 512),
  MAX_BODY_BYTES: int(4096, 64),
  MAX_PAYLOAD_BYTES: int(4096, 64),
  JOIN_TIMEOUT_MS: int(5000, 50),
  HEARTBEAT_MS: int(15000, 50),
  RATE_LIMIT_PER_SEC: int(10, 1),
  RATE_LIMIT_BURST: int(20, 1),
  SLOW_CLIENT_BYTES: int(256 * 1024, 1024),
  DEMO_ENDPOINTS: bool(false), // /api/slow і буферизований реплей — лише для дослідів
  QUIET: bool(false),
  // ---- Lab 8: продакшен ----
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ALLOWED_ORIGINS: origins(DEV_ORIGINS), // звідки можна відкривати WebSocket (перевірка Origin)
  MAX_CONNECTIONS_PER_IP: int(8, 1, 100_000),
  TRUST_PROXY: bool(false), // за проксі хостингу IP клієнта — у X-Forwarded-For, а не в сокеті
  GIT_SHA: z.string().min(1).default('dev'), // штамп версії: підставляє збірка Docker
})

// зручні імена полів для коду (camelCase)
export interface ServerConfig {
  readonly port: number
  readonly host: string
  readonly logDir: string
  readonly clientDist: string
  readonly arenasFile: string
  readonly maxRooms: number
  readonly maxPlayersPerRoom: number
  readonly maxBodyBytes: number
  readonly maxPayloadBytes: number
  readonly joinTimeoutMs: number
  readonly heartbeatMs: number
  readonly rateLimitPerSec: number
  readonly rateLimitBurst: number
  readonly slowClientBytes: number
  readonly demoEndpoints: boolean
  readonly quiet: boolean
  readonly logLevel: z.infer<typeof ServerConfigSchema>['LOG_LEVEL']
  readonly allowedOrigins: readonly string[]
  readonly maxConnectionsPerIp: number
  readonly trustProxy: boolean
  readonly version: string
}

// порожні рядки в .env вважаємо "не задано"
function clean(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') out[k] = v
  return out
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<ServerConfig> = {},
): ServerConfig {
  const parsed = ServerConfigSchema.safeParse(clean(env))
  if (!parsed.success) {
    // помилка в конфігу має валити сервер ОДРАЗУ при старті, а не о 3-й ночі
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`Invalid server config:\n${lines.join('\n')}`)
  }
  const c = parsed.data
  return Object.freeze({
    port: c.PORT,
    host: c.HOST,
    logDir: c.LOG_DIR,
    clientDist: c.CLIENT_DIST,
    arenasFile: c.ARENAS_FILE,
    maxRooms: c.MAX_ROOMS,
    maxPlayersPerRoom: c.MAX_PLAYERS_PER_ROOM,
    maxBodyBytes: c.MAX_BODY_BYTES,
    maxPayloadBytes: c.MAX_PAYLOAD_BYTES,
    joinTimeoutMs: c.JOIN_TIMEOUT_MS,
    heartbeatMs: c.HEARTBEAT_MS,
    rateLimitPerSec: c.RATE_LIMIT_PER_SEC,
    rateLimitBurst: c.RATE_LIMIT_BURST,
    slowClientBytes: c.SLOW_CLIENT_BYTES,
    demoEndpoints: c.DEMO_ENDPOINTS,
    quiet: c.QUIET,
    logLevel: c.QUIET ? 'error' : c.LOG_LEVEL,
    allowedOrigins: c.ALLOWED_ORIGINS,
    maxConnectionsPerIp: c.MAX_CONNECTIONS_PER_IP,
    trustProxy: c.TRUST_PROXY,
    version: c.GIT_SHA,
    ...overrides,
  })
}
