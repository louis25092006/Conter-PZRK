// Живий фон лобі: закатне небо над горами, хмари, літаки з інверсійним слідом
// і ракети ПЗРК, що злітають із землі. Чисто декоративний — тому Math.random тут доречний.

const TAU = Math.PI * 2
const rand = (a, b) => a + Math.random() * (b - a)

// силует літака — той самий контур, що й у грі (ніс дивиться вправо)
function planePath(ctx, s) {
  ctx.beginPath()
  ctx.moveTo(20 * s, 0)
  ctx.lineTo(5 * s, 4 * s)
  ctx.lineTo(3 * s, 3 * s)
  ctx.lineTo(-16 * s, 17 * s)
  ctx.lineTo(-10 * s, 5 * s)
  ctx.lineTo(-12 * s, 3 * s)
  ctx.lineTo(-19 * s, 9 * s)
  ctx.lineTo(-17 * s, 0)
  ctx.lineTo(-19 * s, -9 * s)
  ctx.lineTo(-12 * s, -3 * s)
  ctx.lineTo(-10 * s, -5 * s)
  ctx.lineTo(-16 * s, -17 * s)
  ctx.lineTo(3 * s, -3 * s)
  ctx.lineTo(5 * s, -4 * s)
  ctx.closePath()
}

// зубчастий силует гір (детермінований, щоб не "стрибав" при ресайзі)
function ridge(w, baseY, amp, seed, step = 18) {
  const pts = []
  for (let x = -step, i = 0; x <= w + step; x += step, i++) {
    const n =
      Math.sin(i * 0.9 + seed) * 0.5 +
      Math.sin(i * 0.37 + seed * 2.1) * 0.35 +
      Math.sin(i * 2.3 + seed) * 0.15
    pts.push([x, baseY - (n * 0.5 + 0.5) * amp])
  }
  return pts
}

export function createLobbyBackground(ctx) {
  let raf = 0
  let last = 0
  let planes = []
  let missiles = []
  let flashes = []
  let clouds = []
  let missileTimer = 2

  const size = () => ({ w: ctx.canvas.clientWidth, h: ctx.canvas.clientHeight })

  function spawnPlane(initial = false) {
    const { w, h } = size()
    const dir = Math.random() < 0.5 ? 1 : -1
    const depth = rand(0.35, 1) // далекі — дрібніші, повільніші, блідіші
    return {
      dir,
      depth,
      x: initial ? rand(0, w) : dir > 0 ? -60 : w + 60,
      y: rand(h * 0.08, h * 0.45),
      speed: rand(40, 90) * depth,
      bob: rand(0, TAU),
      trail: [],
    }
  }

  function spawnCloud(initial = false) {
    const { w, h } = size()
    return {
      x: initial ? rand(-100, w) : -260,
      y: rand(h * 0.05, h * 0.55),
      r: rand(40, 110),
      speed: rand(6, 16),
      alpha: rand(0.08, 0.2),
    }
  }

  function reset() {
    planes = Array.from({ length: 4 }, () => spawnPlane(true))
    clouds = Array.from({ length: 7 }, () => spawnCloud(true))
    missiles = []
    flashes = []
  }

  function launchMissile() {
    const { w, h } = size()
    const target = planes.filter((p) => p.depth > 0.6)[0] ?? planes[0]
    if (!target) return
    const x = rand(w * 0.1, w * 0.9)
    missiles.push({ x, y: h * 0.86, vx: 0, vy: -260, target, smoke: [], life: 3.2 })
  }

  function update(dt) {
    const { w } = size()
    for (const c of clouds) c.x += c.speed * dt
    clouds = clouds.filter((c) => c.x - c.r * 2 < w)
    while (clouds.length < 7) clouds.push(spawnCloud())

    for (const p of planes) {
      p.x += p.dir * p.speed * dt
      p.bob += dt
      p.trail.push([p.x - p.dir * 18 * p.depth, p.y + Math.sin(p.bob) * 3])
      if (p.trail.length > 70) p.trail.shift()
    }
    planes = planes.filter((p) => p.x > -120 && p.x < w + 120)
    while (planes.length < 4) planes.push(spawnPlane())

    missileTimer -= dt
    if (missileTimer <= 0) {
      missileTimer = rand(2.5, 5)
      launchMissile()
    }
    for (const m of missiles) {
      // самонаведення як у грі: повертаємо вектор швидкості до цілі
      const tx = m.target.x - m.x
      const ty = m.target.y - m.y
      const want = Math.atan2(ty, tx)
      const cur = Math.atan2(m.vy, m.vx)
      let diff = want - cur
      while (diff > Math.PI) diff -= TAU
      while (diff < -Math.PI) diff += TAU
      const a = cur + Math.max(-2.2 * dt, Math.min(2.2 * dt, diff))
      const sp = Math.hypot(m.vx, m.vy) + 120 * dt
      m.vx = Math.cos(a) * sp
      m.vy = Math.sin(a) * sp
      m.x += m.vx * dt
      m.y += m.vy * dt
      m.life -= dt
      m.smoke.push({ x: m.x, y: m.y, age: 0 })
      if (Math.hypot(tx, ty) < 16 * m.target.depth + 6 || m.life <= 0) {
        flashes.push({ x: m.x, y: m.y, age: 0 })
        m.dead = true
      }
    }
    for (const m of missiles) for (const s of m.smoke) s.age += dt
    missiles = missiles.filter((m) => !m.dead || m.smoke.some((s) => s.age < 1.6))
    for (const m of missiles) m.smoke = m.smoke.filter((s) => s.age < 1.6)
    for (const f of flashes) f.age += dt
    flashes = flashes.filter((f) => f.age < 0.7)
  }

  function draw() {
    const { w, h } = size()
    const horizon = h * 0.74

    // небо: від нічного синього вгорі до помаранчевого заходу біля горизонту
    const sky = ctx.createLinearGradient(0, 0, 0, horizon)
    sky.addColorStop(0, '#0a1630')
    sky.addColorStop(0.45, '#2b2550')
    sky.addColorStop(0.75, '#9c4a52')
    sky.addColorStop(1, '#f2a65a')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, w, h)

    // сонце біля горизонту
    const sx = w * 0.72
    const sun = ctx.createRadialGradient(sx, horizon, 10, sx, horizon, h * 0.45)
    sun.addColorStop(0, 'rgba(255, 220, 150, 0.95)')
    sun.addColorStop(0.08, 'rgba(255, 190, 110, 0.55)')
    sun.addColorStop(1, 'rgba(255, 140, 80, 0)')
    ctx.fillStyle = sun
    ctx.fillRect(0, 0, w, h)

    // хмари
    for (const c of clouds) {
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r * 1.6)
      g.addColorStop(0, `rgba(255, 220, 200, ${c.alpha})`)
      g.addColorStop(1, 'rgba(255, 220, 200, 0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.ellipse(c.x, c.y, c.r * 1.8, c.r * 0.55, 0, 0, TAU)
      ctx.fill()
    }

    // літаки та інверсійні сліди
    for (const p of [...planes].sort((a, b) => a.depth - b.depth)) {
      ctx.lineCap = 'round'
      for (let i = 1; i < p.trail.length; i++) {
        const t = i / p.trail.length
        ctx.strokeStyle = `rgba(255, 240, 230, ${0.25 * t * p.depth})`
        ctx.lineWidth = 2.5 * p.depth * t + 0.5
        ctx.beginPath()
        ctx.moveTo(...p.trail[i - 1])
        ctx.lineTo(...p.trail[i])
        ctx.stroke()
      }
      ctx.save()
      ctx.translate(p.x, p.y + Math.sin(p.bob) * 3)
      if (p.dir < 0) ctx.scale(-1, 1)
      planePath(ctx, 1.1 * p.depth)
      ctx.fillStyle = `rgba(16, 14, 30, ${0.5 + 0.5 * p.depth})`
      ctx.fill()
      ctx.restore()
    }

    // ракети: дим + розжарений хвіст
    for (const m of missiles) {
      for (const s of m.smoke) {
        const a = Math.max(0, 0.35 * (1 - s.age / 1.6))
        ctx.fillStyle = `rgba(220, 210, 200, ${a})`
        ctx.beginPath()
        ctx.arc(s.x, s.y, 2 + s.age * 7, 0, TAU)
        ctx.fill()
      }
      if (!m.dead) {
        ctx.fillStyle = '#fff3c4'
        ctx.beginPath()
        ctx.arc(m.x, m.y, 2.2, 0, TAU)
        ctx.fill()
      }
    }
    for (const f of flashes) {
      const r = 6 + f.age * 50
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r)
      g.addColorStop(0, `rgba(255, 240, 180, ${1 - f.age / 0.7})`)
      g.addColorStop(1, 'rgba(255, 120, 40, 0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(f.x, f.y, r, 0, TAU)
      ctx.fill()
    }

    // гори в два шари + земля
    for (const [baseY, amp, seed, color] of [
      [horizon + 6, h * 0.16, 1.3, '#3a2445'],
      [horizon + 30, h * 0.1, 4.7, '#1d1528'],
    ]) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.moveTo(0, h)
      for (const [x, y] of ridge(w, baseY, amp, seed)) ctx.lineTo(x, y)
      ctx.lineTo(w, h)
      ctx.closePath()
      ctx.fill()
    }
    ctx.fillStyle = '#0e0b16'
    ctx.fillRect(0, h * 0.86, w, h * 0.14)

    // віньєтка, щоб панель читалась
    const v = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.3,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.75,
    )
    v.addColorStop(0, 'rgba(0, 0, 0, 0)')
    v.addColorStop(1, 'rgba(0, 0, 0, 0.55)')
    ctx.fillStyle = v
    ctx.fillRect(0, 0, w, h)
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - (last || now)) / 1000)
    last = now
    update(dt)
    draw()
    raf = requestAnimationFrame(frame)
  }

  return {
    start() {
      if (raf) return
      reset()
      last = 0
      raf = requestAnimationFrame(frame)
    },
    stop() {
      cancelAnimationFrame(raf)
      raf = 0
    },
  }
}
