import { pino, stdTimeFunctions } from 'pino'

// Lab 8: структуровані логи — pino, JSON-рядок на подію в stdout (не у файл).
// Платформа (Render, Fly, Docker) сама збирає stdout; JSON легко фільтрувати:
//   {"level":30,"time":"…","event":"player.joined","roomId":"r-classic","playerId":"…"}
// Інтерфейс Logger лишився той самий (повідомлення + контекст), тож решта коду не змінилась.
// Правило: жодних секретів і повних повідомлень гравців у логах — лише ідентифікатори й причини.

export type LogContext = Readonly<Record<string, unknown>>
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'

export interface Logger {
  info(event: string, ctx?: LogContext): void
  warn(event: string, ctx?: LogContext): void
  error(event: string, ctx?: LogContext): void
  debug(event: string, ctx?: LogContext): void
  // дописати буфер перед виходом (graceful shutdown)
  flush(): Promise<void>
}

export interface LoggerOptions {
  quiet?: boolean
  logLevel?: LogLevel
  version?: string
}

export function createLogger({
  quiet = false,
  logLevel = 'info',
  version = 'dev',
}: LoggerOptions = {}): Logger {
  const log = pino({
    level: quiet ? 'error' : logLevel,
    base: { service: 'conter-server', version },
    messageKey: 'event',
    timestamp: stdTimeFunctions.isoTime,
  })
  return {
    info: (event, ctx) => log.info(ctx ?? {}, event),
    warn: (event, ctx) => log.warn(ctx ?? {}, event),
    error: (event, ctx) => log.error(ctx ?? {}, event),
    debug: (event, ctx) => log.debug(ctx ?? {}, event),
    flush: () => new Promise<void>((resolve) => log.flush(() => resolve())),
  }
}
