// Звук через Web Audio API.
// Цей модуль ВОЛОДІЄ AudioContext. Симуляція про нього не знає — ми самі
// підписуємось на події світу (attach). Браузер не дає грати звук, доки
// користувач не клацне/не натисне клавішу, тому контекст "розблоковується"
// першим жестом (unlock).

export function createAudio() {
  const AudioCtx = globalThis.AudioContext ?? globalThis.webkitAudioContext
  const ctx = AudioCtx ? new AudioCtx() : null // до першого жесту — стан "suspended"
  const master = ctx?.createGain()
  if (master) {
    master.gain.value = 0.5
    master.connect(ctx.destination)
  }

  let buffers = {}
  let muted = false
  const lastPlayed = new Map() // щоб 20 пострілів/с не злились у гул

  function play(key, { volume = 1, rate = 1, minGapMs = 30 } = {}) {
    const buffer = buffers[key]
    if (!ctx || !buffer || muted || ctx.state !== 'running') return // немає звуку → гра просто тиха
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

  // події симуляції → звуки. Повертає функцію відписки.
  function attach(world) {
    const handlers = {
      fired: (e) =>
        e.detail.team === 'player' ? play('shoot', { volume: 0.6 }) : play('enemy-shoot', { volume: 0.45 }),
      hit: () => play('hit', { volume: 0.7, minGapMs: 50 }),
      exploded: (e) => {
        const { kind, size } = e.detail
        // маленький камінь — тихіше й вище, літак — на повну
        play('explosion', {
          volume: kind === 'ship' ? 1 : 0.35 + size * 0.15,
          rate: kind === 'ship' ? 0.9 : 1.5 - size * 0.15,
          minGapMs: 0,
        })
      },
      pickup: () => play('pickup', { volume: 0.8, minGapMs: 0 }),
    }
    for (const [type, fn] of Object.entries(handlers)) world.addEventListener(type, fn)
    return () => {
      for (const [type, fn] of Object.entries(handlers)) world.removeEventListener(type, fn)
    }
  }

  return {
    ctx,
    setBuffers(map) {
      buffers = map
    },
    // викликати з обробника кліку/клавіші
    unlock() {
      if (ctx && ctx.state === 'suspended') return ctx.resume()
    },
    get state() {
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
