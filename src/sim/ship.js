import { Entity } from './entity.js'
import { Bullet } from './bullet.js'
import { Vector2 } from './vector.js'
import { wrapAround } from './arena.js'
import { controllers, homing, tickEffects, EFFECTS } from './components.js'

// Lab 1: корабель був простим об'єктом + функція integrate().
// Lab 2: той самий корабель, але як клас Ship extends Entity (один рівень).
// І гравець, і вороги — це Ship; різниця лише в ship.controller і параметрах.

const DRAG = 0.97 // множник швидкості за крок (60 разів/с) — плавне гальмування
const BULLET_SPEED = 600
const RAPID_COOLDOWN = 0.05
const RESPAWN_DELAY = 2
const SPAWN_INVULNERABILITY = 2

export class Ship extends Entity {
  #hp // приватне: змінити здоров'я можна лише через damage()/respawn()

  constructor({
    team = 'player',
    controller = 'keyboard',
    maxHp = 10,
    turnSpeed = 6, // рад/с
    thrustPower = 900, // px/с²
    maxSpeed = 300, // px/с
    fireCooldown = 0.1, // с між пострілами (10 куль/с)
    ...rest
  } = {}) {
    super({ kind: 'ship', radius: 16, team, ...rest })
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
    this.snapPrevious()
  }

  update(dt, world) {
    if (this.respawnIn > 0) {
      this.respawnIn -= dt
      if (this.respawnIn <= 0) this.#respawn(world)
      return
    }

    this.cooldown = Math.max(0, this.cooldown - dt)
    this.invulnerable = Math.max(0, this.invulnerable - dt)
    tickEffects(this.effects, dt)

    // "мозок" корабля — компонент, обраний за назвою
    const command = controllers[this.controller](this, world, dt)

    this.angle += command.turn * this.turnSpeed * dt
    this.thrust = command.thrust
    if (this.thrust) {
      this.vel = this.vel.add(Vector2.fromAngle(this.angle, this.thrustPower * dt))
    }
    this.vel = this.vel.scale(DRAG).clampLength(this.maxSpeed)

    super.update(dt, world)
    wrapAround(this, world.width, world.height)

    // ВАЖЛИВО: виклик через крапку — this усередині fire() буде саме цей корабель
    if (command.fire) this.fire(world)
  }

  // Куля вилітає з носа і УСПАДКОВУЄ швидкість корабля.
  fire(world) {
    if (this.cooldown > 0) return null
    this.cooldown = this.effects.has('rapid') ? RAPID_COOLDOWN : this.fireCooldown

    const dir = Vector2.fromAngle(this.angle)
    const muzzle = this.pos.add(dir.scale(this.radius + 6))
    const vel = this.vel.add(dir.scale(BULLET_SPEED))
    const bullet = new Bullet({
      x: muzzle.x,
      y: muzzle.y,
      vx: vel.x,
      vy: vel.y,
      angle: this.angle,
      team: this.team,
      ownerId: this.id,
    })
    if (this.effects.has('homing')) {
      bullet.homing = homing({
        turnRate: 5,
        range: 450,
        targetKinds: ['ship', 'asteroid'],
        ownTeam: this.team,
      })
      bullet.ttl = 1.8
    }
    world.emit('fired', { team: this.team, homing: !!bullet.homing, x: muzzle.x, y: muzzle.y })
    return world.spawn(bullet)
  }
}
