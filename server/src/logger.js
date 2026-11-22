// Маленький логер: час, рівень, повідомлення, контекст. Без залежностей.
export function createLogger({ quiet = false } = {}) {
  function write(level, msg, ctx) {
    if (quiet && level !== 'error') return
    const time = new Date().toISOString().slice(11, 23)
    const extra = ctx ? ' ' + JSON.stringify(ctx) : ''
    const line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`
    if (level === 'error' || level === 'warn') console.error(line)
    else console.log(line)
  }
  return {
    info: (msg, ctx) => write('info', msg, ctx),
    warn: (msg, ctx) => write('warn', msg, ctx),
    error: (msg, ctx) => write('error', msg, ctx),
  }
}
