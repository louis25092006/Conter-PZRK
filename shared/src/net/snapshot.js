import { EFFECTS } from '../sim/components.js'

// Знімок світу — "правда" сервера на один тік, у вигляді простих даних.
// Його кодують у JSON або в бінарний формат (codec/), і з нього клієнт малює світ.
// Вибухи (частинки) не надсилаємо: клієнт малює їх сам за подіями 'exploded'/'hit'.

export const EFFECT_NAMES = Object.keys(EFFECTS) // ['shield', 'rapid', 'homing']

function shipData(e) {
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
    effects: Object.fromEntries(EFFECT_NAMES.map((n) => [n, e.effects.get(n) ?? 0])),
    score: e.score,
    deaths: e.deaths,
  }
}

const toData = {
  ship: shipData,
  bullet: (e) => ({
    id: e.id,
    kind: 'bullet',
    x: e.pos.x,
    y: e.pos.y,
    angle: e.vel.angle(),
    team: e.team,
    homing: !!e.homing,
    ownerId: e.ownerId ?? 0,
    spawnSeq: e.spawnSeq ?? 0,
  }),
  asteroid: (e) => ({
    id: e.id,
    kind: 'asteroid',
    x: e.pos.x,
    y: e.pos.y,
    angle: e.angle,
    size: e.size,
    variant: e.variant,
    homing: !!e.homing,
  }),
  pickup: (e) => ({
    id: e.id,
    kind: 'pickup',
    x: e.pos.x,
    y: e.pos.y,
    angle: 0,
    effect: e.effect,
    ttl: e.ttl,
  }),
}

export function entityToData(e) {
  return e.alive && toData[e.kind] ? toData[e.kind](e) : null
}

// Події, що сталися за тік (для звуку, HUD і вибухів на клієнті) — лише потрібні поля
const eventFields = {
  fired: ['team', 'shipId', 'homing'],
  hit: ['team', 'shipId', 'target'],
  exploded: ['team', 'shipId', 'kind', 'size'],
  pickup: ['shipId', 'effect'],
  score: ['shipId', 'delta'],
}

export function eventToData(type, detail) {
  const out = { type, x: detail.x, y: detail.y }
  for (const f of eventFields[type] ?? []) if (detail[f] !== undefined) out[f] = detail[f]
  return out
}

export const EVENT_TYPES = Object.keys(eventFields)

// Підписатися на світ і збирати події між тіками
export function collectEvents(world) {
  const buffer = []
  for (const type of EVENT_TYPES)
    world.addEventListener(type, (e) => buffer.push(eventToData(type, e.detail)))
  return {
    drain: () => buffer.splice(0),
  }
}

// Сутності знімаються ОДИН раз за тік (спільні для всіх гравців),
// а ack і you — свої для кожного клієнта.
export function snapshotEntities(world) {
  const list = []
  for (const e of world) {
    const d = entityToData(e)
    if (d) list.push(d)
  }
  return list
}

export function makeSnapshot({ tick, ack, you, entities, events }) {
  return { type: 'snapshot', tick, ack, you, entities, events }
}
