// Маленький логер: час, рівень, повідомлення, контекст. Без залежностей.
export type LogContext = Readonly<Record<string, unknown>>
export interface Logger {
  info(msg: string, ctx?: LogContext): void
  warn(msg: string, ctx?: LogContext): void
  error(msg: string, ctx?: LogContext): void
}

type Level = 'info' | 'warn' | 'error'

export function createLogger({ quiet = false }: { quiet?: boolean } = {}): Logger {
  function write(level: Level, msg: string, ctx?: LogContext): void {
    if (quiet && level !== 'error') return
    const time = new Date().toISOString().slice(11, 23)
    const extra = ctx ? ' ' + JSON.stringify(ctx) : ''
    const line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`
    if (level === 'info') console.log(line)
    else console.error(line)
  }
  return {
    info: (msg, ctx) => write('info', msg, ctx),
    warn: (msg, ctx) => write('warn', msg, ctx),
    error: (msg, ctx) => write('error', msg, ctx),
  }
}
