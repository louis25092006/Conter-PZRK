import type { World, AnyEntity } from '../sim/world.ts'
import type { EntityData, Snapshot } from '../protocol.ts'
import { GAME_EVENT_TYPES, type GameEvent } from '../events.ts'
import { assertNever, toSeq, type EntityId, type Seq, type Tick } from '../types.ts'

// Знімок світу — "правда" сервера на один тік, у вигляді простих даних.
// Його кодують у JSON або в бінарний формат (codec/), і з нього клієнт малює світ.
// Вибухи (частинки) не надсилаємо: клієнт малює їх сам за подіями 'exploded'/'hit'.

export function entityToData(e: AnyEntity): EntityData | null {
  if (!e.alive) return null
  switch (e.kind) {
    case 'ship':
      return {
        id: e.id,
        kind: 'ship',
        x: e.pos.x,
        y: e.pos.y,
        angle: e.angle,
        team: e.team,
        vx: e.vel.x,
        vy: e.vel.y,
        hp: e.hp,
        maxHp: e.maxHp,
        thrust: e.thrust,
        respawnIn: Math.max(0, e.respawnIn),
        invulnerable: e.invulnerable,
        cooldown: e.cooldown,
        effects: {
          shield: e.effects.get('shield') ?? 0,
          rapid: e.effects.get('rapid') ?? 0,
          homing: e.effects.get('homing') ?? 0,
        },
        score: e.score,
        deaths: e.deaths,
      }
    case 'bullet':
      return {
        id: e.id,
        kind: 'bullet',
        x: e.pos.x,
        y: e.pos.y,
        angle: e.vel.angle(),
        team: e.team,
        homing: e.homing !== null,
        ownerId: e.ownerId,
        spawnSeq: e.spawnSeq,
      }
    case 'asteroid':
      return {
        id: e.id,
        kind: 'asteroid',
        x: e.pos.x,
        y: e.pos.y,
        angle: e.angle,
        size: e.size,
        variant: e.variant,
        homing: e.homing !== null,
      }
    case 'pickup':
      return { id: e.id, kind: 'pickup', x: e.pos.x, y: e.pos.y, angle: 0, effect: e.effect, ttl: e.ttl }
    case 'explosion':
      return null // частинки клієнт малює сам
    default:
      return assertNever(e, 'entity kind') // новий вид сутності — помилка компіляції тут
  }
}

// Підписатися на події світу і збирати їх між тіками
export function collectEvents(world: World): { drain(): GameEvent[] } {
  const buffer: GameEvent[] = []
  for (const type of GAME_EVENT_TYPES) world.events.on(type, (ev) => buffer.push(ev))
  return { drain: () => buffer.splice(0) }
}

// Сутності знімаються ОДИН раз за тік (спільні для всіх гравців),
// а ack і you — свої для кожного клієнта.
export function snapshotEntities(world: World): EntityData[] {
  const list: EntityData[] = []
  for (const e of world) {
    const d = entityToData(e)
    if (d) list.push(d)
  }
  return list
}

export function makeSnapshot(p: {
  tick: Tick
  ack: Seq | null
  you: EntityId | null
  entities: readonly EntityData[]
  events: readonly GameEvent[]
}): Snapshot {
  return {
    type: 'snapshot',
    tick: p.tick,
    ack: p.ack ?? toSeq(0),
    you: p.you,
    entities: p.entities,
    events: p.events,
  }
}
