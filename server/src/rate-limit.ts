// Token bucket: у відрі до `burst` жетонів, щосекунди додається `perSec`.
// Кожне повідомлення забирає жетон. Немає жетона — клієнт спамить.
export interface TokenBucket {
  take(): boolean
  readonly tokens: number
}

export function createTokenBucket({
  perSec,
  burst,
  now = () => performance.now(),
}: {
  perSec: number
  burst: number
  now?: () => number
}): TokenBucket {
  let tokens = burst
  let last = now()
  return {
    take() {
      const t = now()
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSec)
      last = t
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
    get tokens() {
      return tokens
    },
  }
}
