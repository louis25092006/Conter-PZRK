// Lab 7, M1: цикл з фіксованим кроком (Lab 1) під фейковими таймерами.
// requestAnimationFrame замінюємо setTimeout(16 мс), а годинник — Date.now(), який
// vi.useFakeTimers() теж «заморожує»: час іде лише тоді, коли тест скаже vi.advanceTimersByTime.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createLoop } from '../src/loop.ts'

const FRAME_MS = 16

function makeLoop(opts: { simulate?: (dt: number) => void; render?: (alpha: number) => void } = {}) {
  const simulate = vi.fn(opts.simulate ?? (() => {}))
  const render = vi.fn(opts.render ?? (() => {}))
  const loop = createLoop({
    simulate,
    render,
    raf: (cb) => Number(setTimeout(() => cb(Date.now()), FRAME_MS)),
    caf: (id) => clearTimeout(id),
    now: () => Date.now(),
  })
  return { loop, simulate, render }
}

describe('цикл гри (акумулятор)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('за 1 с — рівно ~60 кроків симуляції незалежно від частоти кадрів', () => {
    const { loop, simulate } = makeLoop()
    loop.start()
    vi.advanceTimersByTime(1000 + FRAME_MS)
    loop.stop()
    expect(simulate.mock.calls.length).toBeGreaterThanOrEqual(59)
    expect(simulate.mock.calls.length).toBeLessThanOrEqual(61)
    expect(simulate.mock.calls.every(([dt]) => dt === 1 / 60)).toBe(true) // крок завжди фіксований
  })

  test('alpha для рендеру завжди в [0, 1)', () => {
    const { loop, render } = makeLoop()
    loop.start()
    vi.advanceTimersByTime(500)
    loop.stop()
    expect(render).toHaveBeenCalled()
    for (const [alpha] of render.mock.calls) {
      expect(alpha).toBeGreaterThanOrEqual(0)
      expect(alpha).toBeLessThan(1)
    }
  })

  test('довгий «фриз» (2 с без кадрів) не запускає спіраль смерті: максимум 0.25 с = 15 кроків', () => {
    const { loop, simulate } = makeLoop()
    loop.start()
    vi.advanceTimersByTime(FRAME_MS * 3) // кілька нормальних кадрів
    const before = simulate.mock.calls.length
    // вкладка «заснула»: годинник стрибає на 2 с уперед між двома кадрами
    vi.setSystemTime(Date.now() + 2000)
    vi.advanceTimersByTime(FRAME_MS)
    loop.stop()
    const after = simulate.mock.calls.length
    expect(after - before).toBeLessThanOrEqual(16) // 0.25 с · 60 + поточний кадр
  })

  test('stop() усередині simulate: більше ні кроків, ні рендеру цього кадру', () => {
    let calls = 0
    const holder: { stop?: () => void } = {}
    const { loop, render } = makeLoop({
      simulate: () => {
        calls++
        if (calls === 3) holder.stop?.()
      },
    })
    holder.stop = () => loop.stop()
    loop.start()
    vi.advanceTimersByTime(1000)
    expect(calls).toBe(3)
    const renders = render.mock.calls.length
    vi.advanceTimersByTime(1000)
    expect(render.mock.calls.length).toBe(renders) // цикл справді зупинився
  })

  test('після паузи start() не «наздоганяє» час простою', () => {
    const { loop, simulate } = makeLoop()
    loop.start()
    vi.advanceTimersByTime(200)
    loop.stop()
    vi.advanceTimersByTime(5000) // гравець 5 с у лобі
    const before = simulate.mock.calls.length
    loop.start()
    vi.advanceTimersByTime(FRAME_MS * 2)
    loop.stop()
    expect(simulate.mock.calls.length - before).toBeLessThanOrEqual(3)
  })

  test('статистика: steps/s і frames/s оновлюються раз на секунду', () => {
    const { loop } = makeLoop()
    loop.start()
    vi.advanceTimersByTime(2100)
    loop.stop()
    expect(loop.stats.stepsPerSec).toBeGreaterThanOrEqual(59)
    expect(loop.stats.framesPerSec).toBeGreaterThanOrEqual(55) // 1000 / 16 ≈ 62 кадри
  })
})
