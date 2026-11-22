import type { Bus } from '../../shared/src/bus.ts'
import type { GameEvents } from '../../shared/src/events.ts'

// Звук через Web Audio API.
// Цей модуль ВОЛОДІЄ AudioContext. Симуляція про нього не знає — ми самі
// підписуємось на події гри (attach). Браузер не дає грати звук до першого жесту
// користувача, тому контекст "розблоковується" першим кліком/клавішею (unlock).

export type SoundKey = 'shoot' | 'enemy-shoot' | 'hit' | 'explosion' | 'pickup'
export type SoundState = 'unsupported' | 'muted' | AudioContextState

export interface Audio {
  readonly ctx: AudioContext | null
  setBuffers(map: Readonly<Record<string, AudioBuffer>>): void
  unlock(): void
  readonly state: SoundState
  toggleMute(): void
  attach(events: Bus<GameEvents>): () => void
  play(key: SoundKey, opts?: { volume?: number; rate?: number; minGapMs?: number }): void
}

export function createAudio(): Audio {
  const ctx = typeof AudioContext === 'function' ? new AudioContext() : null // до першого жесту — "suspended"
  const master = ctx?.createGain() ?? null
  if (ctx && master) {
    master.gain.value = 0.5
    master.connect(ctx.destination)
  }

  let buffers: Readonly<Record<string, AudioBuffer>> = {}
  let muted = false
  const lastPlayed = new Map<SoundKey, number>() // щоб 20 пострілів/с не злились у гул

  function play(key: SoundKey, { volume = 1, rate = 1, minGapMs = 30 } = {}): void {
    const buffer = buffers[key]
    if (!ctx || !master || !buffer || muted || ctx.state !== 'running') return // немає звуку → гра просто тиха
    const now = performance.now()
    if (now - (lastPlayed.get(key) ?? -Infinity) < minGapMs) return
    lastPlayed.set(key, now)

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = rate
    const gain = ctx.createGain()
    gain.gain.value = volume
    source.connect(gain).connect(master)
    source.start()
  }

  // події гри → звуки (Bus<GameEvents>: обробник 'exploded' точно знає про ev.kind і ev.size)
  function attach(events: Bus<GameEvents>): () => void {
    const offs = [
      events.on('fired', (ev) =>
        ev.team === 'player' ? play('shoot', { volume: 0.6 }) : play('enemy-shoot', { volume: 0.45 }),
      ),
      events.on('hit', () => play('hit', { volume: 0.7, minGapMs: 50 })),
      events.on('exploded', (ev) =>
        // маленький камінь — тихіше й вище, літак — на повну
        play('explosion', {
          volume: ev.kind === 'ship' ? 1 : 0.35 + ev.size * 0.15,
          rate: ev.kind === 'ship' ? 0.9 : 1.5 - ev.size * 0.15,
          minGapMs: 0,
        }),
      ),
      events.on('pickup', () => play('pickup', { volume: 0.8, minGapMs: 0 })),
    ]
    return () => offs.forEach((off) => off())
  }

  return {
    ctx,
    setBuffers(map) {
      buffers = map
    },
    unlock() {
      if (ctx && ctx.state === 'suspended') void ctx.resume()
    },
    get state(): SoundState {
      if (!ctx) return 'unsupported'
      return muted ? 'muted' : ctx.state
    },
    toggleMute() {
      muted = !muted
    },
    attach,
    play,
  }
}
