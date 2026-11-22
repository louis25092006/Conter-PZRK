// =====================================================================
//  Бінарний протокол Conter-PZRK, версія 1  (DataView, LITTLE-ENDIAN скрізь)
// =====================================================================
//
//  Через бінарні кадри WebSocket ідуть лише ЧАСТІ повідомлення: команди гравця (60/с)
//  і знімки світу (30/с). Рідкісні (join, roster, chat, ping) лишаються JSON-текстом.
//
//  ---- INPUT (клієнт → сервер), 8 байтів ----------------------------------
//   off  тип    поле
//    0   u8     msgType = 1
//    1   u8     version = 1
//    2   u32    seq        номер команди (зростає на 1 щокроку симуляції)
//    6   i8     turn       -1 | 0 | 1
//    7   u8     buttons    bit0 = thrust, bit1 = fire
//
//  ---- SNAPSHOT (сервер → клієнт) ------------------------------------------
//   Заголовок, 17 байтів:
//    0   u8     msgType = 2
//    1   u8     version = 1
//    2   u32    tick       номер тіку сервера (30/с)
//    6   u32    ack        останній seq цього клієнта, який сервер застосував
//   10   u32    you        id літака цього клієнта (0 — ще немає)
//   14   u16    entityCount
//   16   u8     eventCount
//
//   Кожна сутність — спільна частина, 15 байтів:
//    +0  u32    id
//    +4  u8     kind       1 ship, 2 bullet, 3 asteroid, 4 pickup
//    +5  f32    x
//    +9  f32    y
//   +13  i16    angle      у тисячних радіана, зведений до [-π, π] (квантування: 2 байти замість 8)
//   далі — частина за kind:
//    ship (+28):     u8 team, f32 vx, f32 vy, u8 hp, u8 maxHp, u8 flags (bit0 thrust),
//                    u8 respawnIn, u8 invulnerable (десяті частки секунди),
//                    f32 cooldown (точно — від нього залежить передбачення пострілу),
//                    u8 shield, u8 rapid, u8 homing (залишок ефекту, десяті частки с),
//                    u32 score, u16 deaths
//    bullet (+10):   u8 team, u8 homing, u32 ownerId, u32 spawnSeq
//    asteroid (+3):  u8 size, u8 variant, u8 homing
//    pickup (+2):    u8 effect (0 shield, 1 rapid, 2 homing), u8 ttl (десяті частки с)
//
//   Кожна подія — фіксовано 18 байтів:
//    +0 u8 type (1 fired, 2 hit, 3 exploded, 4 pickup, 5 score)
//    +1 f32 x, +5 f32 y, +9 u8 team, +10 u8 a, +11 u8 size, +12 u32 shipId, +16 u16 value
//      a:     fired → homing (0/1); hit → target (0 ship, 1 asteroid);
//             exploded → kind (1 ship, 3 asteroid); pickup → effect
//      value: score → delta
//
//  team: 0 player, 1 enemy, 2 neutral.
//  Невідомий msgType або version → помилка (сервер закриє з'єднання).
// =====================================================================

import { EFFECT_NAMES } from '../net/snapshot.js'

export const MSG = Object.freeze({ INPUT: 1, SNAPSHOT: 2 })
export const VERSION = 1
const LE = true

const TEAMS = ['player', 'enemy', 'neutral']
const KINDS = [null, 'ship', 'bullet', 'asteroid', 'pickup']
const EVENTS = [null, 'fired', 'hit', 'exploded', 'pickup', 'score']
const teamCode = (t) => Math.max(0, TEAMS.indexOf(t))

const ENTITY_SIZE = { ship: 15 + 28, bullet: 15 + 10, asteroid: 15 + 3, pickup: 15 + 2 }
const HEADER = 17
const EVENT_SIZE = 18

const TAU = Math.PI * 2
function packAngle(a) {
  a = ((a % TAU) + TAU) % TAU // [0, 2π)
  if (a > Math.PI) a -= TAU // [-π, π]
  return Math.round(a * 1000)
}
const unpackAngle = (v) => v / 1000
const deci = (s) => Math.min(255, Math.round(s * 10))

// ---------- INPUT ----------

export function encodeInput({ seq, turn, thrust, fire }) {
  const view = new DataView(new ArrayBuffer(8))
  view.setUint8(0, MSG.INPUT)
  view.setUint8(1, VERSION)
  view.setUint32(2, seq, LE)
  view.setInt8(6, turn)
  view.setUint8(7, (thrust ? 1 : 0) | (fire ? 2 : 0))
  return view.buffer
}

export function decodeInput(bytes) {
  const view = asView(bytes)
  if (view.byteLength !== 8) throw new Error('bad input length')
  if (view.getUint8(0) !== MSG.INPUT || view.getUint8(1) !== VERSION) throw new Error('bad input header')
  const buttons = view.getUint8(7)
  return {
    type: 'input',
    seq: view.getUint32(2, LE),
    turn: view.getInt8(6),
    thrust: (buttons & 1) !== 0,
    fire: (buttons & 2) !== 0,
  }
}

// ---------- SNAPSHOT ----------

export function encodeSnapshot({ tick, ack, you, entities, events }) {
  let size = HEADER + events.length * EVENT_SIZE
  for (const e of entities) size += ENTITY_SIZE[e.kind]
  const view = new DataView(new ArrayBuffer(size))
  view.setUint8(0, MSG.SNAPSHOT)
  view.setUint8(1, VERSION)
  view.setUint32(2, tick, LE)
  view.setUint32(6, ack, LE)
  view.setUint32(10, you ?? 0, LE)
  view.setUint16(14, entities.length, LE)
  view.setUint8(16, events.length)
  let o = HEADER

  for (const e of entities) {
    view.setUint32(o, e.id, LE)
    view.setUint8(o + 4, KINDS.indexOf(e.kind))
    view.setFloat32(o + 5, e.x, LE)
    view.setFloat32(o + 9, e.y, LE)
    view.setInt16(o + 13, packAngle(e.angle), LE)
    o += 15
    if (e.kind === 'ship') {
      view.setUint8(o, teamCode(e.team))
      view.setFloat32(o + 1, e.vx, LE)
      view.setFloat32(o + 5, e.vy, LE)
      view.setUint8(o + 9, e.hp)
      view.setUint8(o + 10, e.maxHp)
      view.setUint8(o + 11, e.thrust ? 1 : 0)
      view.setUint8(o + 12, deci(e.respawnIn))
      view.setUint8(o + 13, deci(e.invulnerable))
      view.setFloat32(o + 14, e.cooldown, LE)
      view.setUint8(o + 18, deci(e.effects.shield))
      view.setUint8(o + 19, deci(e.effects.rapid))
      view.setUint8(o + 20, deci(e.effects.homing))
      view.setUint32(o + 21, e.score, LE)
      view.setUint16(o + 25, e.deaths, LE)
      o += 28
    } else if (e.kind === 'bullet') {
      view.setUint8(o, teamCode(e.team))
      view.setUint8(o + 1, e.homing ? 1 : 0)
      view.setUint32(o + 2, e.ownerId, LE)
      view.setUint32(o + 6, e.spawnSeq, LE)
      o += 10
    } else if (e.kind === 'asteroid') {
      view.setUint8(o, e.size)
      view.setUint8(o + 1, e.variant)
      view.setUint8(o + 2, e.homing ? 1 : 0)
      o += 3
    } else if (e.kind === 'pickup') {
      view.setUint8(o, EFFECT_NAMES.indexOf(e.effect))
      view.setUint8(o + 1, deci(e.ttl))
      o += 2
    }
  }

  for (const ev of events) {
    view.setUint8(o, EVENTS.indexOf(ev.type))
    view.setFloat32(o + 1, ev.x, LE)
    view.setFloat32(o + 5, ev.y, LE)
    view.setUint8(o + 9, teamCode(ev.team))
    const a = {
      fired: ev.homing ? 1 : 0,
      hit: ev.target === 'asteroid' ? 1 : 0,
      exploded: ev.kind === 'asteroid' ? 3 : 1,
      pickup: EFFECT_NAMES.indexOf(ev.effect),
    }[ev.type]
    view.setUint8(o + 10, a ?? 0)
    view.setUint8(o + 11, ev.size ?? 0)
    view.setUint32(o + 12, ev.shipId ?? 0, LE)
    view.setUint16(o + 16, ev.delta ?? 0, LE)
    o += EVENT_SIZE
  }
  return view.buffer
}

export function decodeSnapshot(bytes) {
  const view = asView(bytes)
  if (view.getUint8(0) !== MSG.SNAPSHOT) throw new Error('not a snapshot')
  if (view.getUint8(1) !== VERSION)
    throw new Error(`snapshot version ${view.getUint8(1)}, expected ${VERSION}`)
  const count = view.getUint16(14, LE)
  const eventCount = view.getUint8(16)
  const snap = {
    type: 'snapshot',
    tick: view.getUint32(2, LE),
    ack: view.getUint32(6, LE),
    you: view.getUint32(10, LE),
    entities: [],
    events: [],
  }
  let o = HEADER
  for (let i = 0; i < count; i++) {
    const kind = KINDS[view.getUint8(o + 4)]
    const e = {
      id: view.getUint32(o, LE),
      kind,
      x: view.getFloat32(o + 5, LE),
      y: view.getFloat32(o + 9, LE),
      angle: unpackAngle(view.getInt16(o + 13, LE)),
    }
    o += 15
    if (kind === 'ship') {
      Object.assign(e, {
        team: TEAMS[view.getUint8(o)],
        vx: view.getFloat32(o + 1, LE),
        vy: view.getFloat32(o + 5, LE),
        hp: view.getUint8(o + 9),
        maxHp: view.getUint8(o + 10),
        thrust: view.getUint8(o + 11) === 1,
        respawnIn: view.getUint8(o + 12) / 10,
        invulnerable: view.getUint8(o + 13) / 10,
        cooldown: view.getFloat32(o + 14, LE),
        effects: {
          shield: view.getUint8(o + 18) / 10,
          rapid: view.getUint8(o + 19) / 10,
          homing: view.getUint8(o + 20) / 10,
        },
        score: view.getUint32(o + 21, LE),
        deaths: view.getUint16(o + 25, LE),
      })
      o += 28
    } else if (kind === 'bullet') {
      Object.assign(e, {
        team: TEAMS[view.getUint8(o)],
        homing: view.getUint8(o + 1) === 1,
        ownerId: view.getUint32(o + 2, LE),
        spawnSeq: view.getUint32(o + 6, LE),
      })
      o += 10
    } else if (kind === 'asteroid') {
      Object.assign(e, {
        size: view.getUint8(o),
        variant: view.getUint8(o + 1),
        homing: view.getUint8(o + 2) === 1,
      })
      o += 3
    } else if (kind === 'pickup') {
      Object.assign(e, { effect: EFFECT_NAMES[view.getUint8(o)], ttl: view.getUint8(o + 1) / 10 })
      o += 2
    } else {
      throw new Error(`unknown entity kind at byte ${o - 15}`)
    }
    snap.entities.push(e)
  }
  for (let i = 0; i < eventCount; i++) {
    const type = EVENTS[view.getUint8(o)]
    const ev = { type, x: view.getFloat32(o + 1, LE), y: view.getFloat32(o + 5, LE) }
    const team = TEAMS[view.getUint8(o + 9)]
    const a = view.getUint8(o + 10)
    const shipId = view.getUint32(o + 12, LE)
    if (type === 'fired') Object.assign(ev, { team, shipId, homing: a === 1 })
    else if (type === 'hit') Object.assign(ev, { team, shipId, target: a === 1 ? 'asteroid' : 'ship' })
    else if (type === 'exploded')
      Object.assign(ev, { team, shipId, kind: a === 3 ? 'asteroid' : 'ship', size: view.getUint8(o + 11) })
    else if (type === 'pickup') Object.assign(ev, { shipId, effect: EFFECT_NAMES[a] })
    else if (type === 'score') Object.assign(ev, { shipId, delta: view.getUint16(o + 16, LE) })
    snap.events.push(ev)
    o += EVENT_SIZE
  }
  return snap
}

// Buffer у Node — це Uint8Array, що може дивитися в СЕРЕДИНУ більшого ArrayBuffer (пул).
// Тому обов'язково враховуємо byteOffset, інакше читатимемо чужі байти.
function asView(bytes) {
  if (bytes instanceof ArrayBuffer) return new DataView(bytes)
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
