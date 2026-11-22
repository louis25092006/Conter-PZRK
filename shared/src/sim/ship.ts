import { Entity, type EntityInit } from './entity.ts'
import { Bullet } from './bullet.ts'
import { Vector2 } from './vector.ts'
import { controllers, homing, tickEffects, EFFECTS, type ControllerName } from './components.ts'
import {
  stepShip,
  muzzle,
  PLAYER_SHIP,
  type MotionState,
  type ShipParams,
  type Command,
} from './ship-physics.ts'
import type { World } from './world.ts'
import type { EffectName, Seq } from '../types.ts'

// Lab 1: корабель був простим об'єктом + функція integrate().
// Lab 2: той самий корабель, але як клас Ship extends Entity (один рівень).
// Lab 5: рух винесено в чисту функцію stepShip() (ship-physics.ts), щоб клієнт
//        міг передбачати свій літак ТОЧНО так само, як рахує сервер.

const RESPAWN_DELAY = 2
const SPAWN_INVULNERABILITY = 2

export interface ShipInit extends EntityInit, Partial<ShipParams> {
  controller?: ControllerName
  maxHp?: number
}

export class Ship extends Entity {
  readonly kind: 'ship' = 'ship'
  #hp: number // приватне: змінити здоров'я можна лише через damage()/respawn()

  controller: ControllerName
  readonly maxHp: number
  readonly turnSpeed: number
  readonly thrustPower: number
  readonly maxSpeed: number
  readonly fireCooldown: number

  thrust = false // для рендера полум'я
  cooldown = 0
  readonly effects = new Map<EffectName, number>() // назва ефекту -> секунд залишилось
  invulnerable = 0 // секунди невразливості після респауну
  respawnIn = 0 // > 0 => корабель збитий і чекає респауну
  score = 0 // Lab 5: очки й смерті в кожного гравця свої
  deaths = 0
  lastSeq: Seq | null = null // номер останньої застосованої команди гравця (для звірки на клієнті)

  constructor({
    team = 'player',
    controller = 'input',
    maxHp = PLAYER_SHIP.maxHp,
    turnSpeed = PLAYER_SHIP.turnSpeed,
    thrustPower = PLAYER_SHIP.thrustPower,
    maxSpeed = PLAYER_SHIP.maxSpeed,
    fireCooldown = PLAYER_SHIP.fireCooldown,
    ...rest
  }: ShipInit = {}) {
    super({ radius: PLAYER_SHIP.radius, team, ...rest })
    this.controller = controller
    this.maxHp = maxHp
    this.#hp = maxHp
    this.turnSpeed = turnSpeed
    this.thrustPower = thrustPower
    this.maxSpeed = maxSpeed
    this.fireCooldown = fireCooldown
  }

  get hp(): number {
    return this.#hp
  }

  get isWaitingRespawn(): boolean {
    return this.respawnIn > 0
  }

  get params(): ShipParams {
    return {
      turnSpeed: this.turnSpeed,
      thrustPower: this.thrustPower,
      maxSpeed: this.maxSpeed,
      fireCooldown: this.fireCooldown,
    }
  }

  // повертає true, якщо корабель знищено цим пострілом
  damage(amount: number): boolean {
    if (!this.collidable || this.invulnerable > 0) return false
    if (this.effects.has('shield')) return false // щит поглинає все, поки активний
    this.#hp = Math.max(0, this.#hp - amount)
    return this.#hp === 0
  }

  applyEffect(name: EffectName): void {
    this.effects.set(name, EFFECTS[name].duration)
  }

  startRespawn(): void {
    this.respawnIn = RESPAWN_DELAY
    this.collidable = false
    this.thrust = false
    this.effects.clear()
  }

  #respawn(world: World): void {
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
  motionState(): MotionState {
    return {
      x: this.pos.x,
      y: this.pos.y,
      vx: this.vel.x,
      vy: this.vel.y,
      angle: this.angle,
      cooldown: this.cooldown,
    }
  }

  override update(dt: number, world: World): void {
    // Сервер може дати КІЛЬКА команд за крок (наздоганяє після затримки в мережі).
    const result = controllers[this.controller](this, world)
    const commands: readonly Command[] = isCommandList(result) ? result : [result]
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
      if (fired) this.fire(world, command.seq ?? null)
    }
  }

  // Куля вилітає з носа і УСПАДКОВУЄ швидкість корабля.
  fire(world: World, seq: Seq | null = this.lastSeq): Bullet {
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
    bullet.spawnSeq = seq // клієнт за цим номером замінить свою передбачену кулю
    if (this.effects.has('homing')) {
      bullet.homing = homing({
        turnRate: 5,
        range: 450,
        targetKinds: ['ship', 'asteroid'],
        ownTeam: this.team,
      })
      bullet.ttl = 1.8
    }
    world.events.emit('fired', {
      type: 'fired',
      team: this.team,
      shipId: this.id,
      homing: bullet.homing !== null,
      x: m.x,
      y: m.y,
    })
    return world.spawn(bullet)
  }
}

// Array.isArray(x) не звужує readonly-масиви в TS — тому власний предикат
function isCommandList(x: Command | readonly Command[]): x is readonly Command[] {
  return Array.isArray(x)
}
