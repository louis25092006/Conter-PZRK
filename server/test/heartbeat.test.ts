// Lab 7, M1: heartbeat під фейковими таймерами — без справжніх сокетів і без очікування 30 с.
// Сокет «впроваджуємо» (dependency injection) простим об'єктом, а не через vi.mock.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { startHeartbeat, type Pingable } from '../src/heartbeat.ts'

class FakeSocket implements Pingable {
  pings = 0
  terminated = false
  missedPongs = 0
  ping(): void {
    this.pings++
  }
  terminate(): void {
    this.terminated = true
  }
  pong(): void {
    this.missedPongs = 0 // так робить обробник 'pong' у ws.ts
  }
}

describe('heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function start(sockets: FakeSocket[]) {
    const onTerminate = vi.fn()
    const hb = startHeartbeat({
      intervalMs: 1000,
      clients: () => sockets,
      missed: (s) => s,
      onTerminate,
    })
    return { hb, onTerminate }
  }

  test('мовчазний клієнт: 2 ping без відповіді, на 3-му тіку — terminate', () => {
    const s = new FakeSocket()
    const { hb, onTerminate } = start([s])
    vi.advanceTimersByTime(2000)
    expect(s.pings).toBe(2)
    expect(s.terminated).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(s.terminated).toBe(true)
    expect(onTerminate).toHaveBeenCalledWith(s)
    hb.stop()
  })

  test('живий клієнт, що відповідає pong, не обривається ніколи', () => {
    const s = new FakeSocket()
    const { hb } = start([s])
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(1000)
      s.pong()
    }
    expect(s.pings).toBe(100)
    expect(s.terminated).toBe(false)
    hb.stop()
  })

  test('stop() зупиняє перевірки', () => {
    const s = new FakeSocket()
    const { hb } = start([s])
    vi.advanceTimersByTime(1000)
    hb.stop()
    vi.advanceTimersByTime(10_000)
    expect(s.pings).toBe(1)
    expect(s.terminated).toBe(false)
  })

  test('сокет без стану (ще не зареєстрований) пропускається', () => {
    const s = new FakeSocket()
    const hb = startHeartbeat({ intervalMs: 1000, clients: () => [s], missed: () => undefined })
    vi.advanceTimersByTime(5000)
    expect(s.pings).toBe(0)
    hb.stop()
  })
})
