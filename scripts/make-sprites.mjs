// Генерує спрайт-листи (SVG) у public/assets/sprites/.
// Запуск: npm run assets
// Спрайти генеруються кодом, а не малюються руками, щоб їх можна було
// відтворити й підправити (кольори, кількість кратерів) одним запуском.

import { mkdirSync, writeFileSync } from 'node:fs'
import { createRng } from '../src/sim/random.js'

const OUT = new URL('../public/assets/sprites/', import.meta.url)
mkdirSync(OUT, { recursive: true })

const f = (n) => Number(n.toFixed(2))

// ---------- літаки: 2 кадри 128×128 (гравець, ворог), ніс дивиться вправо ----------

const PALETTES = {
  player: {
    body: ['#ffffff', '#c9c9c9'],
    wing: '#cfcfcf',
    tail: '#b5b5b5',
    stroke: '#777',
    cockpit: '#4a90d9',
  },
  enemy: {
    body: ['#e0503f', '#8e2a1f'],
    wing: '#962d22',
    tail: '#7b241c',
    stroke: '#3a0f0b',
    cockpit: '#f5b041',
  },
}

function plane(id, cx, p) {
  // ті самі координати, що й у векторному літаку з Lab 1, збільшені втричі
  return `
  <g transform="translate(${cx} 64) scale(3)" stroke="${p.stroke}" stroke-width="0.6" stroke-linejoin="round">
    <path d="M3 3 L-16 17 L-10 5 Z M3 -3 L-16 -17 L-10 -5 Z" fill="${p.wing}"/>
    <path d="M20 0 L5 4 L-15 3 L-19 0 L-15 -3 L5 -4 Z" fill="url(#body-${id})"/>
    <path d="M-12 3 L-19 9 L-15 2 Z M-12 -3 L-19 -9 L-15 -2 Z" fill="${p.tail}"/>
    <ellipse cx="9" cy="0" rx="4" ry="2" fill="${p.cockpit}" stroke="none"/>
    <ellipse cx="10" cy="-0.6" rx="1.6" ry="0.6" fill="#ffffff" opacity="0.6" stroke="none"/>
  </g>`
}

const gradients = Object.entries(PALETTES)
  .map(
    ([id, p]) => `
    <linearGradient id="body-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${p.body[0]}"/><stop offset="1" stop-color="${p.body[1]}"/>
    </linearGradient>`,
  )
  .join('')

writeFileSync(
  new URL('ships.svg', OUT),
  `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128" viewBox="0 0 256 128">
  <defs>${gradients}</defs>${plane('player', 64, PALETTES.player)}${plane('enemy', 192, PALETTES.enemy)}
</svg>
`,
)

// ---------- кулі: 3 кадри 32×32 (гравець, ворог, самонавідна) ----------

const BULLETS = [
  ['player', '#fff3b0', '#ffb703'],
  ['enemy', '#ffd0d0', '#ff3b3b'],
  ['homing', '#f3e0ff', '#a64dff'],
]
writeFileSync(
  new URL('bullets.svg', OUT),
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="32" viewBox="0 0 96 32">
  <defs>${BULLETS.map(
    ([id, core, glow]) => `
    <radialGradient id="b-${id}">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.25" stop-color="${core}"/>
      <stop offset="0.55" stop-color="${glow}" stop-opacity="0.8"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/>
    </radialGradient>`,
  ).join('')}
  </defs>
  ${BULLETS.map(([id], i) => `<circle cx="${16 + i * 32}" cy="16" r="15" fill="url(#b-${id})"/>`).join('\n  ')}
</svg>
`,
)

// ---------- астероїди: 4 варіанти × 2 ряди (звичайні, розпечені самонавідні) ----------
// Номінальний радіус каменя R = 56 у клітинці 128×128. Загальне освітлення (світло
// зверху зліва) НЕ запікаємо — гра накладає його окремо, щоб тінь не оберталась разом
// з каменем. Тому і кратери тут "нейтральні" щодо напрямку світла.

const R = 56
const ROCK = {
  normal: {
    base: '#7a6d62',
    dark: '#4e443c',
    edge: '#2b241f',
    speck: ['#c8b9a5', '#231c16'],
    floor: '#3a312a',
    rim: '#a8988a',
  },
  homing: {
    base: '#86402f',
    dark: '#5a2219',
    edge: '#ff6b6b',
    speck: ['#ffb07a', '#2a0806'],
    floor: '#4a1d17',
    rim: '#ff9d6e',
  },
}

function rockPath(shape, cx, cy) {
  const n = shape.length
  const pt = (i) => {
    const a = (i / n) * Math.PI * 2
    return [cx + Math.cos(a) * R * shape[i % n], cy + Math.sin(a) * R * shape[i % n]]
  }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  let d = `M${mid(pt(0), pt(1)).map(f).join(' ')}`
  for (let i = 1; i <= n; i++) {
    const c = pt(i)
    const m = mid(pt(i), pt(i + 1))
    d += ` Q${f(c[0])} ${f(c[1])} ${f(m[0])} ${f(m[1])}`
  }
  return d + ' Z'
}

function asteroid(variant, kind, col, row) {
  // однаковий seed для обох рядів: розпечений камінь — та сама форма, інший колір
  const rng = createRng(100 + variant * 17)
  const c = ROCK[kind]
  const cx = col * 128 + 64
  const cy = row * 128 + 64
  const id = `${kind}-${variant}`
  const shape = Array.from({ length: 13 }, () => rng.range(0.8, 1.06))

  const craters = []
  for (let tries = 0; craters.length < 7 && tries < 80; tries++) {
    const big = craters.length === 0
    const r = big ? rng.range(0.22, 0.3) : rng.range(0.06, 0.15)
    const a = rng.range(0, Math.PI * 2)
    const d = rng.range(0.05, 0.74 - r)
    const cr = { x: Math.cos(a) * d, y: Math.sin(a) * d, r }
    if (!craters.some((o) => Math.hypot(o.x - cr.x, o.y - cr.y) < (o.r + cr.r) * 0.95)) craters.push(cr)
  }
  const specks = Array.from({ length: 40 }, () => {
    const a = rng.range(0, Math.PI * 2)
    const d = Math.sqrt(rng.next()) * 0.85
    return { x: Math.cos(a) * d, y: Math.sin(a) * d, r: rng.range(0.6, 2.2), light: rng.chance(0.5) }
  })

  return `
  <g>
    <clipPath id="clip-${id}"><path d="${rockPath(shape, cx, cy)}"/></clipPath>
    <path d="${rockPath(shape, cx, cy)}" fill="url(#surface-${kind})"/>
    <g clip-path="url(#clip-${id})">
      ${specks
        .map(
          (s) =>
            `<circle cx="${f(cx + s.x * R)}" cy="${f(cy + s.y * R)}" r="${f(s.r)}" fill="${s.light ? c.speck[0] : c.speck[1]}" opacity="0.4"/>`,
        )
        .join('\n      ')}
      ${craters
        .map((k) => {
          const x = f(cx + k.x * R)
          const y = f(cy + k.y * R)
          const r = f(k.r * R)
          return `<circle cx="${x}" cy="${y}" r="${f(r * 1.12)}" fill="${c.rim}" opacity="0.35"/>
      <circle cx="${x}" cy="${y}" r="${r}" fill="url(#crater-${kind})"/>
      <circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${c.edge}" stroke-width="0.8" opacity="0.5"/>`
        })
        .join('\n      ')}
    </g>
    <path d="${rockPath(shape, cx, cy)}" fill="none" stroke="${c.edge}" stroke-width="2"/>
  </g>`
}

const rockDefs = Object.entries(ROCK)
  .map(
    ([kind, c]) => `
    <radialGradient id="surface-${kind}" cx="0.5" cy="0.5" r="0.55">
      <stop offset="0" stop-color="${c.base}"/><stop offset="1" stop-color="${c.dark}"/>
    </radialGradient>
    <radialGradient id="crater-${kind}">
      <stop offset="0" stop-color="${c.floor}" stop-opacity="1"/>
      <stop offset="0.7" stop-color="${c.floor}" stop-opacity="0.85"/>
      <stop offset="1" stop-color="${c.dark}" stop-opacity="0.6"/>
    </radialGradient>`,
  )
  .join('')

let rocks = ''
for (const [row, kind] of ['normal', 'homing'].entries()) {
  for (let v = 0; v < 4; v++) rocks += asteroid(v, kind, v, row)
}

writeFileSync(
  new URL('asteroids.svg', OUT),
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="256" viewBox="0 0 512 256">
  <defs>${rockDefs}
  </defs>${rocks}
</svg>
`,
)

console.log('sprites written to', OUT.pathname)
