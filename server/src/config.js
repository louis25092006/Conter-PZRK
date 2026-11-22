import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Уся конфігурація — зі змінних середовища (process.env), з перевіркою.
// У dev їх підставляє `node --env-file-if-exists=.env` (див. .env.example).
// Помилка в конфігу має валити сервер ОДРАЗУ при старті, а не о 3-й ночі.

const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url))

function int(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Config: ${name} must be an integer in [${min}, ${max}], got "${raw}"`)
  }
  return n
}

function bool(env, name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (['1', 'true', 'yes'].includes(raw.toLowerCase())) return true
  if (['0', 'false', 'no'].includes(raw.toLowerCase())) return false
  throw new Error(`Config: ${name} must be true/false, got "${raw}"`)
}

export function loadConfig(env = process.env, overrides = {}) {
  const config = {
    port: int(env, 'PORT', 3000, { min: 0, max: 65535 }),
    host: env.HOST || '0.0.0.0',
    logDir: resolve(SERVER_ROOT, env.LOG_DIR || 'logs'),
    clientDist: resolve(SERVER_ROOT, env.CLIENT_DIST || '../client/dist'),

    maxRooms: int(env, 'MAX_ROOMS', 20, { min: 1, max: 1000 }),
    maxPlayersPerRoom: int(env, 'MAX_PLAYERS_PER_ROOM', 8, { min: 1, max: 100 }),
    maxBodyBytes: int(env, 'MAX_BODY_BYTES', 4096, { min: 64 }),
    maxPayloadBytes: int(env, 'MAX_PAYLOAD_BYTES', 4096, { min: 64 }),

    joinTimeoutMs: int(env, 'JOIN_TIMEOUT_MS', 5000, { min: 50 }),
    heartbeatMs: int(env, 'HEARTBEAT_MS', 15000, { min: 50 }),
    rateLimitPerSec: int(env, 'RATE_LIMIT_PER_SEC', 10, { min: 1 }),
    rateLimitBurst: int(env, 'RATE_LIMIT_BURST', 20, { min: 1 }),
    slowClientBytes: int(env, 'SLOW_CLIENT_BYTES', 256 * 1024, { min: 1024 }),

    demoEndpoints: bool(env, 'DEMO_ENDPOINTS', false), // /api/slow і буферизований реплей — лише для дослідів
    quiet: bool(env, 'QUIET', false),
    ...overrides,
  }
  return Object.freeze(config)
}
