// Lab 7, M4: графік місткості — p99 тривалості тіку від кількості клієнтів (дані load-test.ts).
//   node scripts/capacity-chart.ts  →  docs/lab-07/capacity.svg
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

interface Series {
  readonly name: string
  readonly color: string
  readonly points: readonly (readonly [n: number, p99: number])[]
}
const SERIES: readonly Series[] = [
  {
    name: 'ДО (O(n²) колізії, знімок кодується N разів)',
    color: '#c0392b',
    points: [
      [8, 2.88],
      [32, 11.08],
      [64, 29.96],
      [128, 74.12],
    ],
  },
  {
    name: 'ПІСЛЯ (сітка + один знімок на тік)',
    color: '#2e7d32',
    points: [
      [8, 2.71],
      [32, 5.35],
      [64, 10.07],
      [128, 21.68],
      [256, 35.9],
    ],
  },
]
const BUDGET = 1000 / 30

const W = 760
const H = 420
const L = 60
const R = 20
const T = 40
const B = 60
const xs = [8, 16, 32, 64, 128, 256]
const yMax = 80
const x = (n: number): number => L + ((Math.log2(n) - 3) / (Math.log2(256) - 3)) * (W - L - R)
const y = (ms: number): number => T + (1 - ms / yMax) * (H - T - B)

const parts: string[] = []
for (let ms = 0; ms <= yMax; ms += 10) {
  parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(ms)}" y2="${y(ms)}" stroke="#e5e0d5"/>`)
  parts.push(`<text x="${L - 8}" y="${y(ms) + 4}" text-anchor="end" font-size="11" fill="#555">${ms}</text>`)
}
for (const n of xs)
  parts.push(
    `<text x="${x(n)}" y="${H - B + 18}" text-anchor="middle" font-size="11" fill="#555">${n}</text>`,
  )
parts.push(
  `<line x1="${L}" x2="${W - R}" y1="${y(BUDGET)}" y2="${y(BUDGET)}" stroke="#333" stroke-dasharray="6 4"/>`,
)
parts.push(
  `<text x="${W - R - 4}" y="${y(BUDGET) - 6}" text-anchor="end" font-size="12" fill="#333">бюджет тіку 33.3 мс (30 Гц)</text>`,
)
SERIES.forEach((s, i) => {
  parts.push(
    `<polyline fill="none" stroke="${s.color}" stroke-width="2.5" points="${s.points.map(([n, ms]) => `${x(n)},${y(ms)}`).join(' ')}"/>`,
  )
  for (const [n, ms] of s.points) {
    parts.push(`<circle cx="${x(n)}" cy="${y(ms)}" r="4" fill="${s.color}"/>`)
    parts.push(`<text x="${x(n) + 6}" y="${y(ms) - 6}" font-size="11" fill="${s.color}">${ms}</text>`)
  }
  parts.push(`<rect x="${L + 10}" y="${T + 8 + i * 20}" width="14" height="4" fill="${s.color}"/>`)
  parts.push(`<text x="${L + 30}" y="${T + 13 + i * 20}" font-size="12" fill="#222">${s.name}</text>`)
})
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">
<rect width="100%" height="100%" fill="#fdfaf3"/>
<text x="${L}" y="22" font-size="14" fill="#222">Тривалість тіку сервера, p99 (мс) — залежно від кількості клієнтів</text>
${parts.join('\n')}
<text x="${(L + W - R) / 2}" y="${H - 18}" text-anchor="middle" font-size="12" fill="#333">клієнтів у кімнаті (N, логарифмічна шкала)</text>
</svg>
`
const out = fileURLToPath(new URL('../../docs/lab-07/capacity.svg', import.meta.url))
writeFileSync(out, svg)
console.log(`written ${out}`)
