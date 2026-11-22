// Синтезує звукові ефекти у WAV (16 біт, моно) у public/assets/sounds/.
// Запуск: npm run assets
// Звуки згенеровані кодом — без чужих файлів і проблем з ліцензіями.

import { mkdirSync, writeFileSync } from 'node:fs'
import { createRng } from '../../shared/src/sim/random.ts'

const OUT = new URL('../public/assets/sounds/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const RATE = 22050

function wav(samples: readonly number[]): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16) // розмір fmt-блоку
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // моно
  h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

function render(seconds: number, fn: (t: number, p: number) => number): number[] {
  const n = Math.floor(seconds * RATE)
  return Array.from({ length: n }, (_, i) => fn(i / RATE, i / n))
}

const rng = createRng(42)
const noise = () => rng.next() * 2 - 1

// постріл: короткий "пиу" — квадратна хвиля, частота падає 1100 → 280 Гц
function shoot(from: number, to: number, len: number, vol: number): number[] {
  let phase = 0
  return render(len, (t, p) => {
    phase += (from + (to - from) * p) / RATE
    const square = phase % 1 < 0.5 ? 1 : -1
    return square * vol * (1 - p) ** 2
  })
}

// влучання: глухий удар (синус 140 → 60 Гц) + клацання шуму
function hit() {
  let phase = 0
  return render(0.14, (t, p) => {
    phase += (140 - 80 * p) / RATE
    return (Math.sin(phase * Math.PI * 2) * 0.6 + noise() * 0.35 * (1 - p) ** 6) * (1 - p) ** 2
  })
}

// вибух: шум через фільтр низьких частот, що поступово "закривається"
function explosion() {
  let low = 0
  return render(0.9, (t, p) => {
    const cutoff = 0.25 * (1 - p) + 0.02
    low += (noise() - low) * cutoff
    const rumble = Math.sin(t * Math.PI * 2 * (55 - 25 * p)) * 0.3
    return (low * 1.6 + rumble) * (1 - p) ** 1.5 * Math.min(1, t * 200)
  })
}

// бонус: три ноти вгору (арпеджіо)
function pickup() {
  const notes = [660, 880, 1320]
  return render(0.3, (t, p) => {
    const k = Math.min(2, Math.floor(p * 3))
    const local = p * 3 - k
    return Math.sin(t * Math.PI * 2 * (notes[k] ?? 660)) * 0.35 * (1 - local) ** 0.5 * (1 - p * 0.5)
  })
}

const sounds = {
  'shoot.wav': shoot(1100, 280, 0.09, 0.22),
  'enemy-shoot.wav': shoot(520, 140, 0.13, 0.2),
  'hit.wav': hit(),
  'explosion.wav': explosion(),
  'pickup.wav': pickup(),
}
for (const [name, samples] of Object.entries(sounds)) writeFileSync(new URL(name, OUT), wav(samples))
console.log('sounds written to', OUT.pathname)
