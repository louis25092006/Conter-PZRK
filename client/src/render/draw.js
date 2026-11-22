import { EFFECTS } from '../sim/components.js'

// ---------- вспомогательные функции интерполяции ----------

function lerp(a, b, t) {
  // линейная интерполяция: при t=0 вернёт a, при t=1 вернёт b, между — промежуточное значение
  return a + (b - a) * t
}

function lerpAngle(a, b, t) {
  // интерполяция угла с исправлением "кратчайшего пути" по кругу
  let diff = b - a
  while (diff > Math.PI) diff -= 2 * Math.PI
  while (diff < -Math.PI) diff += 2 * Math.PI
  return a + diff * t
}

// позиция и угол любой сущности между предыдущим и текущим шагом физики
function interpolate(e, alpha) {
  return {
    x: lerp(e.prevPos.x, e.pos.x, alpha),
    y: lerp(e.prevPos.y, e.pos.y, alpha),
    angle: lerpAngle(e.prevAngle, e.angle, alpha),
  }
}

// ---------- палитры самолётов ----------
// игрок — светлый, как в Lab 1; враги — тот же самолёт, но в тёмно-красных тонах

const PALETTES = {
  player: { body: '#e8e8e8', wing: '#cfcfcf', tail: '#b5b5b5', stroke: '#888', cockpit: '#4a90d9' },
  enemy: { body: '#c0392b', wing: '#962d22', tail: '#7b241c', stroke: '#4a1410', cockpit: '#f5b041' },
}

// ---------- рисование корпуса самолёта (из Lab 1) ----------

function drawFuselage(ctx, p) {
  // фюзеляж — вытянутый шестиугольник, нос справа (+x), хвост слева (-x)
  ctx.beginPath()
  ctx.moveTo(20, 0)
  ctx.lineTo(5, 4)
  ctx.lineTo(-15, 3)
  ctx.lineTo(-19, 0)
  ctx.lineTo(-15, -3)
  ctx.lineTo(5, -4)
  ctx.closePath()
  ctx.fillStyle = p.body
  ctx.fill()
  ctx.strokeStyle = p.stroke
  ctx.lineWidth = 1
  ctx.stroke()
}

function drawWings(ctx, p) {
  // стреловидные крылья — правое и зеркальное левое (y с минусом)
  for (const s of [1, -1]) {
    ctx.beginPath()
    ctx.moveTo(3, 3 * s)
    ctx.lineTo(-16, 17 * s)
    ctx.lineTo(-10, 5 * s)
    ctx.closePath()
    ctx.fillStyle = p.wing
    ctx.fill()
    ctx.strokeStyle = p.stroke
    ctx.stroke()
  }
}

function drawTailFins(ctx, p) {
  // хвостовые стабилизаторы — маленькие треугольники у хвоста
  for (const s of [1, -1]) {
    ctx.beginPath()
    ctx.moveTo(-12, 3 * s)
    ctx.lineTo(-19, 9 * s)
    ctx.lineTo(-15, 2 * s)
    ctx.closePath()
    ctx.fillStyle = p.tail
    ctx.fill()
    ctx.stroke()
  }
}

function drawCockpit(ctx, p) {
  ctx.beginPath()
  ctx.ellipse(9, 0, 4, 2, 0, 0, Math.PI * 2)
  ctx.fillStyle = p.cockpit
  ctx.fill()
}

// ---------- анимированное пламя (из Lab 1) ----------

function flameShape(ctx, length, width) {
  ctx.beginPath()
  ctx.moveTo(-19, width)
  ctx.quadraticCurveTo(-19 - length * 0.6, width * 0.4, -19 - length, 0)
  ctx.quadraticCurveTo(-19 - length * 0.6, -width * 0.4, -19, -width)
  ctx.closePath()
}

function drawFlame(ctx, time) {
  // две синус-волны с разной частотой — "дрожание" без резких скачков
  const flicker = 0.6 + 0.25 * Math.sin(time * 18) + 0.15 * Math.sin(time * 41 + 1.3)
  const length = 10 + 10 * flicker
  const width = 5 + 2 * flicker

  flameShape(ctx, length, width) // внешний оранжевый слой
  ctx.fillStyle = '#ff7b00'
  ctx.fill()

  flameShape(ctx, length * 0.55, width * 0.55) // внутреннее жёлтое "горячее ядро"
  ctx.fillStyle = '#ffe066'
  ctx.fill()
}

// ---------- сущности ----------

function drawShip(ctx, ship, alpha, time, sprites) {
  if (ship.isWaitingRespawn) return // сбит — ждёт респауна
  // после респауна мигает, пока неуязвим
  if (ship.invulnerable > 0 && Math.floor(time * 10) % 2 === 0) return

  const { x, y, angle } = interpolate(ship, alpha)
  const palette = PALETTES[ship.team] ?? PALETTES.player

  ctx.save()
  ctx.translate(x, y)

  if (ship.effects.has('shield')) {
    ctx.beginPath()
    ctx.arc(0, 0, ship.radius + 8 + Math.sin(time * 6) * 1.5, 0, Math.PI * 2)
    ctx.strokeStyle = EFFECTS.shield.color
    ctx.lineWidth = 2
    ctx.globalAlpha = 0.8
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  ctx.rotate(angle)
  if (ship.thrust) drawFlame(ctx, time + ship.id) // + id — чтобы пламя у разных самолётов не дрожало синхронно
  const sheet = sprites?.images.ships
  if (sheet) {
    // Lab 3: самолёт из спрайт-листа (кадр 128×128 рисуем в 44×44)
    const [sx, sy, sw, sh] = sprites.frames.ships[ship.team === 'enemy' ? 'enemy' : 'player']
    ctx.drawImage(sheet, sx, sy, sw, sh, -22, -22, 44, 44)
  } else {
    // запасной вариант (спрайт не загрузился) — векторный самолёт из Lab 1
    drawWings(ctx, palette)
    drawFuselage(ctx, palette)
    drawTailFins(ctx, palette)
    drawCockpit(ctx, palette)
  }
  ctx.restore()

  // полоска HP над вражеским самолётом
  if (ship.team === 'enemy') {
    const w = 28
    ctx.fillStyle = '#330000'
    ctx.fillRect(x - w / 2, y - 28, w, 4)
    ctx.fillStyle = '#ff5c5c'
    ctx.fillRect(x - w / 2, y - 28, (w * ship.hp) / ship.maxHp, 4)
  }
}

function drawBullet(ctx, bullet, alpha, sprites) {
  const { x, y } = interpolate(bullet, alpha)
  const color = bullet.homing ? EFFECTS.homing.color : bullet.team === 'enemy' ? '#ff6b6b' : '#fff3b0'

  // короткий "трассер" позади пули
  const back = bullet.vel.normalize().scale(10)
  ctx.beginPath()
  ctx.moveTo(x - back.x, y - back.y)
  ctx.lineTo(x, y)
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.5
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.globalAlpha = 1

  const sheet = sprites?.images.bullets
  if (sheet) {
    const frame = bullet.homing ? 'homing' : bullet.team === 'enemy' ? 'enemy' : 'player'
    const [sx, sy, sw, sh] = sprites.frames.bullets[frame]
    const size = bullet.homing ? 16 : 13
    ctx.drawImage(sheet, sx, sy, sw, sh, x - size / 2, y - size / 2, size, size)
    return
  }
  ctx.beginPath()
  ctx.arc(x, y, bullet.radius, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
}

// ---------- астероид из спрайт-листа ----------
// Камень с кратерами вращается, а освещение (свет сверху слева) — нет.
// Для этого собираем астероид на маленьком вспомогательном canvas:
// 1) рисуем повёрнутый кадр, 2) поверх, режимом 'source-atop' (только там, где уже есть камень),
// кладём неповёрнутый градиент тени, 3) копируем результат на основной экран.

let scratch = null
function getScratch(size) {
  if (!scratch) scratch = document.createElement('canvas').getContext('2d')
  if (scratch.canvas.width < size || scratch.canvas.height < size) {
    scratch.canvas.width = Math.max(size, scratch.canvas.width)
    scratch.canvas.height = Math.max(size, scratch.canvas.height)
  }
  return scratch
}

const SPRITE_ROCK_RADIUS = 56 // номинальный радиус камня в клетке 128×128 (см. scripts/make-sprites.mjs)

function drawAsteroidSprite(ctx, asteroid, alpha, sheet, frames) {
  const { x, y, angle } = interpolate(asteroid, alpha)
  const r = asteroid.radius
  const half = (r * 64) / SPRITE_ROCK_RADIUS
  const dpr = window.devicePixelRatio || 1
  const size = Math.ceil(half * 2 * dpr)
  const [sx, sy, sw, sh] = frames[asteroid.homing ? 'homing' : 'normal'][asteroid.variant ?? 0]

  const s = getScratch(size)
  s.setTransform(1, 0, 0, 1, 0, 0)
  s.globalCompositeOperation = 'source-over'
  s.clearRect(0, 0, size, size)
  s.setTransform(dpr, 0, 0, dpr, size / 2, size / 2)
  s.rotate(angle)
  s.drawImage(sheet, sx, sy, sw, sh, -half, -half, half * 2, half * 2)

  s.setTransform(dpr, 0, 0, dpr, size / 2, size / 2)
  s.globalCompositeOperation = 'source-atop'
  const shade = s.createRadialGradient(-r * 0.45, -r * 0.45, r * 0.1, -r * 0.2, -r * 0.2, r * 1.35)
  shade.addColorStop(0, 'rgba(255, 240, 220, 0.25)')
  shade.addColorStop(0.45, 'rgba(0, 0, 0, 0)')
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.75)')
  s.fillStyle = shade
  s.fillRect(-half, -half, half * 2, half * 2)
  s.globalCompositeOperation = 'source-over'

  ctx.drawImage(s.canvas, 0, 0, size, size, x - half, y - half, half * 2, half * 2)
}

function drawAsteroid(ctx, asteroid, alpha, sprites) {
  const sheet = sprites?.images.asteroids
  if (sheet) return drawAsteroidSprite(ctx, asteroid, alpha, sheet, sprites.frames.asteroids)

  // запасной вариант — процедурный астероид из Lab 2
  const { x, y, angle } = interpolate(asteroid, alpha)
  const r = asteroid.radius
  const colors = asteroid.homing ? ASTEROID_COLORS.homing : ASTEROID_COLORS.normal

  // свет падает с верхнего левого угла экрана; астероид вращается,
  // поэтому направление на свет в его локальных координатах тоже "крутится"
  const lightX = Math.cos(-Math.PI * 0.75 - angle)
  const lightY = Math.sin(-Math.PI * 0.75 - angle)

  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)

  // 1) неровный каменный контур (сглаженный через середины рёбер)
  asteroidPath(ctx, asteroid.shape, r)
  ctx.fillStyle = colors.base
  ctx.fill()

  // всё дальнейшее рисуем только внутри контура
  ctx.save()
  ctx.clip()

  // 2) мелкие пятна — пыль и камешки на поверхности
  for (const s of asteroid.specks) {
    ctx.beginPath()
    ctx.arc(s.x * r, s.y * r, Math.max(0.6, s.r * r), 0, Math.PI * 2)
    ctx.fillStyle = s.light ? colors.speckLight : colors.speckDark
    ctx.fill()
  }

  // 3) кратеры
  for (const c of asteroid.craters) drawCrater(ctx, c.x * r, c.y * r, c.r * r, lightX, lightY, colors)

  // 4) объём: освещённая сторона светлее, теневая — почти чёрная.
  // Градиент считаем в экранных координатах (без поворота), чтобы тень не вращалась вместе с камнем
  ctx.rotate(-angle)
  const shade = ctx.createRadialGradient(-r * 0.45, -r * 0.45, r * 0.1, -r * 0.2, -r * 0.2, r * 1.35)
  shade.addColorStop(0, 'rgba(255, 240, 220, 0.22)')
  shade.addColorStop(0.45, 'rgba(0, 0, 0, 0)')
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.75)')
  ctx.fillStyle = shade
  ctx.fillRect(-r * 1.2, -r * 1.2, r * 2.4, r * 2.4)
  ctx.restore() // снимаем clip, возвращаем поворот

  // 5) тонкий тёмный край
  asteroidPath(ctx, asteroid.shape, r)
  ctx.strokeStyle = colors.edge
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.restore()
}

const ASTEROID_COLORS = {
  normal: {
    base: '#76695e',
    edge: '#2b241f',
    speckLight: 'rgba(200, 185, 165, 0.35)',
    speckDark: 'rgba(35, 28, 22, 0.45)',
    craterFloor: '#3f362f',
    craterLit: 'rgba(190, 172, 150, 0.55)',
    craterShadow: 'rgba(20, 15, 12, 0.7)',
  },
  // самонаводящиеся — раскалённые красноватые камни
  homing: {
    base: '#7d3a30',
    edge: '#ff6b6b',
    speckLight: 'rgba(255, 170, 120, 0.4)',
    speckDark: 'rgba(40, 10, 8, 0.5)',
    craterFloor: '#4a1d17',
    craterLit: 'rgba(255, 140, 90, 0.55)',
    craterShadow: 'rgba(25, 5, 4, 0.75)',
  },
}

function asteroidPath(ctx, shape, r) {
  const n = shape.length
  const pt = (i) => {
    const a = (i / n) * Math.PI * 2
    return [Math.cos(a) * r * shape[i % n], Math.sin(a) * r * shape[i % n]]
  }
  // кривые через середины рёбер — края камня скруглённые, а не "многоугольник"
  const [x0, y0] = pt(0)
  const [x1, y1] = pt(1)
  ctx.beginPath()
  ctx.moveTo((x0 + x1) / 2, (y0 + y1) / 2)
  for (let i = 1; i <= n; i++) {
    const [cx, cy] = pt(i)
    const [nx, ny] = pt(i + 1)
    ctx.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2)
  }
  ctx.closePath()
}

function drawCrater(ctx, cx, cy, cr, lightX, lightY, colors) {
  // дно кратера
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, cr, 0, Math.PI * 2)
  ctx.fillStyle = colors.craterFloor
  ctx.fill()
  ctx.clip()

  // внутри кратера стенка, обращённая К свету, в тени,
  // а дальняя от света стенка освещена — светлый полумесяц
  ctx.beginPath()
  ctx.arc(cx - lightX * cr * 0.45, cy - lightY * cr * 0.45, cr * 0.85, 0, Math.PI * 2)
  ctx.fillStyle = colors.craterLit
  ctx.fill()
  ctx.beginPath()
  ctx.arc(cx + lightX * cr * 0.25, cy + lightY * cr * 0.25, cr * 0.75, 0, Math.PI * 2)
  ctx.fillStyle = colors.craterShadow
  ctx.fill()
  ctx.restore()

  // светлый вал по краю кратера со стороны света
  const lightAngle = Math.atan2(lightY, lightX)
  ctx.beginPath()
  ctx.arc(cx, cy, cr * 1.05, lightAngle - 1.2, lightAngle + 1.2)
  ctx.strokeStyle = colors.craterLit
  ctx.lineWidth = Math.max(1, cr * 0.18)
  ctx.stroke()
}

function drawPickup(ctx, pickup, time) {
  // последние 3 секунды мигает — скоро исчезнет
  if (pickup.ttl < 3 && Math.floor(time * 6) % 2 === 0) return
  const { x, y } = pickup.pos
  const info = EFFECTS[pickup.effect]
  const pulse = 1 + Math.sin(time * 4) * 0.08

  ctx.save()
  ctx.translate(x, y)
  ctx.scale(pulse, pulse)
  ctx.beginPath()
  ctx.arc(0, 0, pickup.radius, 0, Math.PI * 2)
  ctx.fillStyle = '#111827'
  ctx.fill()
  ctx.strokeStyle = info.color
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.fillStyle = info.color
  ctx.font = 'bold 13px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(info.letter, 0, 1)
  ctx.restore()
}

function drawExplosion(ctx, explosion) {
  const t = explosion.ttl / explosion.maxTtl // 1 → 0
  ctx.fillStyle = explosion.color
  ctx.globalAlpha = Math.max(0, t)
  for (const p of explosion.particles) {
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
  }
  ctx.globalAlpha = 1
}

// ---------- фон: звёзды ----------

export function createStarfield(width, height, count = 160) {
  // фон — чисто декоративный, поэтому Math.random здесь допустим
  return Array.from({ length: count }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    r: Math.random() < 0.15 ? 1.4 : 0.7,
    a: 0.3 + Math.random() * 0.6,
  }))
}

export function drawStarfield(ctx, stars) {
  ctx.fillStyle = '#ffffff'
  for (const s of stars) {
    ctx.globalAlpha = s.a
    ctx.fillRect(s.x, s.y, s.r, s.r)
  }
  ctx.globalAlpha = 1
}

// ---------- весь мир ----------

// sprites = { images, frames } из загрузчика; null/отсутствующий кадр → векторная графика
export function drawWorld(ctx, world, alpha, time, sprites = null) {
  // порядок слоёв: бонусы → астероиды → пули → самолёты → вспышки поверх всего
  for (const p of world.ofKind('pickup')) drawPickup(ctx, p, time)
  for (const a of world.ofKind('asteroid')) drawAsteroid(ctx, a, alpha, sprites)
  for (const b of world.ofKind('bullet')) drawBullet(ctx, b, alpha, sprites)
  for (const s of world.ofKind('ship')) drawShip(ctx, s, alpha, time, sprites)
  for (const e of world.ofKind('explosion')) drawExplosion(ctx, e)
}
