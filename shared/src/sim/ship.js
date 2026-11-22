import { Entity } from './entity.js'
import { Bullet } from './bullet.js'
import { Vector2 } from './vector.js'
import { controllers, homing, tickEffects, EFFECTS } from './components.js'
import { stepShip, muzzle, PLAYER_SHIP } from './ship-physics.js'

// Lab 1: корабель був простим об'єктом + функція integrate().
// Lab 2: той самий корабель, але як клас Ship extends Entity (один рівень).
// Lab 5: рух винесено в чисту функцію stepShip() (ship-physics.js), щоб клієнт
//        міг передбачати свій літак ТОЧНО так само, як рахує сервер.
// І гравець, і вороги — це Ship; різниця лише в ship.controller і параметрах.

const RESPAWN_DELAY = 2
const SPAWN_INVULNERABILITY = 2

export class Ship extends Entity {
  #hp // приватне: змінити здоров'я можна лише через damage()/respawn()

  constructor({
    team = 'player',
    controller = 'input',
    maxHp = PLAYER_SHIP.maxHp,
    turnSpeed = PLAYER_SHIP.turnSpeed, // рад/с
    thrustPower = PLAYER_SHIP.thrustPower, // px/с²
    maxSpeed = PLAYER_SHIP.maxSpeed, // px/с
    fireCooldown = PLAYER_SHIP.fireCooldown, // с між пострілами (10 куль/с)
    ...rest
  } = {}) {
    super({ kind: 'ship', radius: PLAYER_SHIP.radius, team, ...rest })
    this.controller = controller
    this.maxHp = maxHp
    this.#hp = maxHp
    this.turnSpeed = turnSpeed
    this.thrustPower = thrustPower
    this.maxSpeed = maxSpeed
    this.fireCooldown = fireCooldown

    this.thrust = false // для рендера полум'я
    this.cooldown = 0
    this.effects = new Map() // назва ефекту -> секунд залишилось
    this.invulnerable = 0 // секунди невразливості після респауну
    this.respawnIn = 0 // > 0 => корабель збитий і чекає респауну
    this.score = 0 // Lab 5: очки й смерті в кожного гравця свої
    this.deaths = 0
    this.lastSeq = 0 // номер останньої команди гравця, яку застосовано (для звірки на клієнті)
  }

  get hp() {
    return this.#hp
  }

  get isWaitingRespawn() {
    return this.respawnIn > 0
  }

  // повертає true, якщо корабель знищено цим пострілом
  damage(amount) {
    if (!this.collidable || this.invulnerable > 0) return false
    if (this.effects.has('shield')) return false // щит поглинає все, поки активний
    this.#hp = Math.max(0, this.#hp - amount)
    return this.#hp === 0
  }

  applyEffect(name) {
    this.effects.set(name, EFFECTS[name].duration)
  }

  startRespawn() {
    this.respawnIn = RESPAWN_DELAY
    this.collidable = false
    this.thrust = false
    this.effects.clear()
  }

  #respawn(world) {
    this.pos = world.findSafeSpot()
    this.vel = new Vector2(0, 0)
    this.angle = -Math.PI / 2
    this.#hp = this.maxHp
    this.collidable = true
    this.invulnerable = SPAWN_INVULNERABILITY
    this.cooldown = 0
    this.snapPrevious()
  }

  // стан руху як прості числа — те саме, що передбачає клієнт
  motionState() {
    return {
      x: this.pos.x,
      y: this.pos.y,
      vx: this.vel.x,
      vy: this.vel.y,
      angle: this.angle,
      cooldown: this.cooldown,
    }
  }

  update(dt, world) {
    // "мозок" корабля — компонент, обраний за назвою (гравець: команда з мережі/клавіатури)
    // Сервер може дати КІЛЬКА команд за крок (наздоганяє після затримки в мережі) — масив.
    const result = controllers[this.controller](this, world, dt)
    const commands = Array.isArray(result) ? result : [result]
    for (const c of commands) if (c.seq !== undefined) this.lastSeq = c.seq

    if (this.respawnIn > 0) {
      this.respawnIn -= dt
      if (this.respawnIn <= 0) this.#respawn(world)
      return
    }

    this.invulnerable = Math.max(0, this.invulnerable - dt)
    tickEffects(this.effects, dt)

    for (const command of commands) {
      if (command.skip) return // команда гравця ще в дорозі — чекаємо, не вигадуємо рух
      // одна команда = один крок stepShip (рівно як у передбаченні клієнта)
      const s = this.motionState()
      const { wrapped, fired } = stepShip(
        s,
        command,
        { ...this.params, rapid: this.effects.has('rapid') },
        dt,
        world.width,
        world.height,
      )
      this.pos = new Vector2(s.x, s.y)
      this.vel = new Vector2(s.vx, s.vy)
      this.angle = s.angle
      this.cooldown = s.cooldown
      this.thrust = command.thrust
      if (wrapped) this.snapPrevious() // перелетів через край — не "протягувати" інтерполяцію

      // ВАЖЛИВО: виклик через крапку — this усередині fire() буде саме цей корабель
      if (fired) this.fire(world, command.seq)
    }
  }

  get params() {
    return {
      turnSpeed: this.turnSpeed,
      thrustPower: this.thrustPower,
      maxSpeed: this.maxSpeed,
      fireCooldown: this.fireCooldown,
    }
  }

  // Куля вилітає з носа і УСПАДКОВУЄ швидкість корабля.
  fire(world, seq = this.lastSeq) {
    const m = muzzle(this.motionState(), this.radius)
    const bullet = new Bullet({
      x: m.x,
      y: m.y,
      vx: m.vx,
      vy: m.vy,
      angle: this.angle,
      team: this.team,
      ownerId: this.id,
    })
    bullet.spawnSeq = seq ?? 0 // клієнт за цим номером замінить свою передбачену кулю
    if (this.effects.has('homing')) {
      bullet.homing = homing({
        turnRate: 5,
        range: 450,
        targetKinds: ['ship', 'asteroid'],
        ownTeam: this.team,
      })
      bullet.ttl = 1.8
    }
    world.emit('fired', { team: this.team, shipId: this.id, homing: !!bullet.homing, x: m.x, y: m.y })
    return world.spawn(bullet)
  }
}
