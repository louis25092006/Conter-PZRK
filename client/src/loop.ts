export interface LoopStats {
  stepsPerSec: number
  framesPerSec: number
  frameMs: number
}
export interface Loop {
  start(): void
  stop(): void
  readonly stats: Readonly<LoopStats>
}

export function createLoop({
  step = 1 / 60,
  simulate,
  render,
}: {
  step?: number
  simulate: (dt: number) => void
  render: (alpha: number) => void
}): Loop {
  let accumulator = 0
  let lasttime = 0
  let rafId = 0
  let running = false // stop() можуть викликати зсередини кадру (Esc → лобі)

  //HUD
  let stepsThisSecond = 0
  let framesThisSecond = 0
  let statsTimer = 0
  const stats: LoopStats = { stepsPerSec: 0, framesPerSec: 0, frameMs: 0 }

  function frame(now: number): void {
    const frameStart = performance.now()

    if (lasttime === 0) lasttime = now
    const delta = Math.min((now - lasttime) / 1000, 0.25) //защита от "спирали смерти"
    lasttime = now
    accumulator += delta

    while (running && accumulator >= step) {
      simulate(step)
      accumulator -= step
      stepsThisSecond++
    }

    if (!running) return // зупинили під час simulate — не малюємо і не плануємо наступний кадр
    render(accumulator / step) // alpha
    framesThisSecond++

    // обнов стат
    statsTimer += delta
    if (statsTimer >= 1) {
      stats.stepsPerSec = stepsThisSecond
      stats.framesPerSec = framesThisSecond
      stepsThisSecond = 0
      framesThisSecond = 0
      statsTimer = 0
    }
    stats.frameMs = performance.now() - frameStart

    rafId = requestAnimationFrame(frame) //бесконечный цикл, синхронизированный с частотой обновления экрана
  }

  return {
    start() {
      if (running) return
      running = true
      lasttime = 0 // інакше після паузи в лобі перший кадр "наздоганяв" би весь час простою
      accumulator = 0
      rafId = requestAnimationFrame(frame)
    },
    stop() {
      running = false
      cancelAnimationFrame(rafId)
    },
    stats,
  }
}
