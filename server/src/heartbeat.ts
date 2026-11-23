// Heartbeat (Lab 4), винесений окремо (Lab 7), щоб перевіряти його фейковими таймерами.
// Кожні intervalMs: якщо сокет пропустив 2 pong поспіль — обриваємо його,
// інакше рахуємо ще один пропуск і шлемо ping. Відповідь pong обнуляє лічильник (у ws.ts).

export interface Pingable {
  ping(): void
  terminate(): void
}

export interface HeartbeatOptions<S extends Pingable> {
  readonly intervalMs: number
  readonly clients: () => Iterable<S>
  readonly missed: (socket: S) => { missedPongs: number } | undefined
  readonly onTerminate?: (socket: S) => void
  readonly maxMissed?: number
}

export function startHeartbeat<S extends Pingable>(opts: HeartbeatOptions<S>): { stop(): void } {
  const maxMissed = opts.maxMissed ?? 2
  const timer = setInterval(() => {
    for (const socket of opts.clients()) {
      const s = opts.missed(socket)
      if (!s) continue
      if (s.missedPongs >= maxMissed) {
        opts.onTerminate?.(socket)
        socket.terminate()
        continue
      }
      s.missedPongs++
      socket.ping()
    }
  }, opts.intervalMs)
  timer.unref() // таймер не тримає процес живим сам по собі
  return { stop: () => clearInterval(timer) }
}
