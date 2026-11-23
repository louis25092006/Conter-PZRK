export interface LoopStats {
  stepsPerSec: number
  framesPerSec: number
  frameMs: number
}
export interface Loop {
  start(): void
  stop(): void
  readonly stats: Readonly<LoopStats>
  // Lab 7: останні ≤ 4096 кадрів — час роботи кадру (CPU) і проміжок між кадрами
  samples(): { frameMs: Float64Array; intervalMs: Float64Array }
  resetSamples(): void
}

const SAMPLES = 4096

export interface LoopOptions {
  step?: number
  simulate: (dt: number) => void
  render: (alpha: number) => void
  // Lab 7: годинник кадрів передається ззовні — у тестах його замінюють фейковими таймерами
  raf?: (cb: (now: number) => void) => number
  caf?: (id: number) => void
  now?: () => number
}

export function createLoop({
  step = 1 / 60,
  simulate,
  render,
  raf = (cb) => requestAnimationFrame(cb),
  caf = (id) => cancelAnimationFrame(id),
  now: clock = () => performance.now(),
}: LoopOptions): Loop {
  let accumulator = 0
  let lasttime = 0
  let rafId = 0
  let running = false // stop() можуть викликати зсередини кадру (Esc → лобі)

  //HUD
  let stepsThisSecond = 0
  let framesThisSecond = 0
  let statsTimer = 0
  const stats: LoopStats = { stepsPerSec: 0, framesPerSec: 0, frameMs: 0 }
  // кільцеві буфери фіксованого розміру: запис щокадру нічого не алокує
  const frameSamples = new Float64Array(SAMPLES)
  const intervalSamples = new Float64Array(SAMPLES)
  let sampleCount = 0
  let prevNow = 0

  function frame(now: number): void {
    const frameStart = clock()

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
    stats.frameMs = clock() - frameStart
    frameSamples[sampleCount % SAMPLES] = stats.frameMs
    intervalSamples[sampleCount % SAMPLES] = prevNow ? now - prevNow : 0
    sampleCount++
    prevNow = now

    rafId = raf(frame) //бесконечный цикл, синхронизированный с частотой обновления экрана
  }

  return {
    start() {
      if (running) return
      running = true
      lasttime = 0 // інакше після паузи в лобі перший кадр "наздоганяв" би весь час простою
      accumulator = 0
      rafId = raf(frame)
    },
    stop() {
      running = false
      caf(rafId)
    },
    stats,
    samples() {
      const n = Math.min(sampleCount, SAMPLES)
      return { frameMs: frameSamples.slice(0, n), intervalMs: intervalSamples.slice(0, n) }
    },
    resetSamples() {
      sampleCount = 0
      prevNow = 0
    },
  }
}
