// Фізика корабля як ЧИСТА функція над простими числами.
// Її викликають І сервер (через Ship.update), І клієнт (передбачення власного літака).
// Тому тут не можна нічого "приблизно": той самий порядок операцій, ті самі константи,
// жодного Math.random() чи Date.now() — інакше передбачення розійдеться з сервером.

export const SHIP_DRAG = 0.97 // множник швидкості за крок 1/60 с
export const BULLET_SPEED = 600
export const RAPID_COOLDOWN = 0.05
export const SIM_DT = 1 / 60 // один крок симуляції = одна команда гравця

// параметри літака гравця (вороги мають свої — див. spawner.js)
export const PLAYER_SHIP = Object.freeze({
  turnSpeed: 6,
  thrustPower: 900,
  maxSpeed: 300,
  fireCooldown: 0.1,
  radius: 16,
  maxHp: 10,
})

// Для досліду M2: навмисно зламати детермінізм (лише на клієнті!) і подивитись,
// як ростуть поправки при звірці з сервером.
export const debug = { breakDeterminism: false }

// s = { x, y, vx, vy, angle, cooldown } — змінюється на місці.
// cmd = { turn: -1|0|1, thrust: bool, fire: bool }
// p = параметри літака + rapid (чи активний бонус швидкострільності)
export function stepShip(s, cmd, p, dt, width, height) {
  s.cooldown = Math.max(0, s.cooldown - dt)
  s.angle += cmd.turn * p.turnSpeed * dt
  if (cmd.thrust) {
    const len = p.thrustPower * dt
    s.vx += Math.cos(s.angle) * len
    s.vy += Math.sin(s.angle) * len
    if (debug.breakDeterminism) s.vx += (Math.random() - 0.5) * 40 // ← БАГ навмисно
  }
  s.vx *= SHIP_DRAG
  s.vy *= SHIP_DRAG
  const speed = Math.hypot(s.vx, s.vy)
  if (speed > p.maxSpeed) {
    const k = p.maxSpeed / speed
    s.vx *= k
    s.vy *= k
  }
  s.x += s.vx * dt
  s.y += s.vy * dt

  let wrapped = false
  if (s.x < 0) {
    s.x += width
    wrapped = true
  } else if (s.x > width) {
    s.x -= width
    wrapped = true
  }
  if (s.y < 0) {
    s.y += height
    wrapped = true
  } else if (s.y > height) {
    s.y -= height
    wrapped = true
  }

  let fired = false
  if (cmd.fire && s.cooldown <= 0) {
    s.cooldown = p.rapid ? RAPID_COOLDOWN : p.fireCooldown
    fired = true
  }
  return { wrapped, fired }
}

// де і з якою швидкістю народжується куля (той самий розрахунок на сервері й клієнті)
export function muzzle(s, radius) {
  const dx = Math.cos(s.angle)
  const dy = Math.sin(s.angle)
  return {
    x: s.x + dx * (radius + 6),
    y: s.y + dy * (radius + 6),
    vx: s.vx + dx * BULLET_SPEED,
    vy: s.vy + dy * BULLET_SPEED,
  }
}

// нормалізація команди (і перевірка на сервері: turn = 1000 — це чит)
export function normalizeCommand(c) {
  return {
    turn: c.turn > 0 ? 1 : c.turn < 0 ? -1 : 0,
    thrust: c.thrust === true,
    fire: c.fire === true,
  }
}

export const IDLE = Object.freeze({ turn: 0, thrust: false, fire: false })

// Команда гравця ще не дійшла до сервера (затримка/джитер). Літак НЕ рухається на цьому кроці:
// кожна команда дає рівно один крок і на сервері, і в передбаченні клієнта — тож вони не розходяться.
// (Якби сервер "домальовував" рух, повторюючи минулу команду, клієнт отримував би зайвий крок → поправки.)
export const SKIP = Object.freeze({ turn: 0, thrust: false, fire: false, skip: true })
