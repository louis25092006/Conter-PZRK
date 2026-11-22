import { Entity, type EntityInit } from './entity.ts'
import type { Rng } from './random.ts'

// Вибух — купа короткоживучих частинок. Ні з чим не зіштовхується.
// (Тут народжується багато дрібних об'єктів — тема для Lab 7: object pooling.)

export interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  readonly size: number
}

export interface ExplosionInit extends EntityInit {
  rng: Rng
  count?: number
  speed?: number
  color?: string
  ttl?: number
}

export class Explosion extends Entity {
  readonly kind: 'explosion' = 'explosion'
  ttl: number
  readonly maxTtl: number
  readonly color: string
  readonly particles: Particle[]

  constructor({ rng, count = 24, speed = 160, color = '#ffb347', ttl = 0.9, ...rest }: ExplosionInit) {
    super({ radius: 0, ...rest })
    this.collidable = false
    this.ttl = ttl
    this.maxTtl = ttl
    this.color = color
    this.particles = Array.from({ length: count }, () => {
      const a = rng.range(0, Math.PI * 2)
      const s = rng.range(0.25, 1) * speed
      return { x: this.pos.x, y: this.pos.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, size: rng.range(1, 3) }
    })
  }

  override update(dt: number): void {
    this.ttl -= dt
    if (this.ttl <= 0) {
      this.kill()
      return
    }
    for (const p of this.particles) {
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vx *= 0.96
      p.vy *= 0.96
    }
  }
}
