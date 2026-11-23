// =====================================================================
//  Бінарний протокол Conter-PZRK, версія 1  (DataView, LITTLE-ENDIAN скрізь)
// =====================================================================
//
//  Через бінарні кадри WebSocket ідуть лише ЧАСТІ повідомлення: команди гравця (60/с)
//  і знімки світу (30/с). Рідкісні (join, roster, chat, ping) лишаються JSON-текстом.
//
//  ---- INPUT (клієнт → сервер), 8 байтів ----------------------------------
//    0   u8     msgType = 1
//    1   u8     version = 1
//    2   u32    seq        номер команди (зростає на 1 щокроку симуляції)
//    6   i8     turn       -1 | 0 | 1
//    7   u8     buttons    bit0 = thrust, bit1 = fire
//
//  ---- SNAPSHOT (сервер → клієнт) ------------------------------------------
//   Заголовок, 17 байтів:
//    0 u8 msgType = 2 | 1 u8 version = 1 | 2 u32 tick | 6 u32 ack | 10 u32 you (0 — немає)
//   14 u16 entityCount | 16 u8 eventCount
//   Сутність — спільна частина 15 байтів: u32 id, u8 kind (1 ship 2 bullet 3 asteroid 4 pickup),
//   f32 x, f32 y, i16 angle (тисячні радіана в [-π, π]); далі за kind:
//    ship (+27):     u8 team, f32 vx, f32 vy, u8 hp, u8 maxHp, u8 flags (bit0 thrust),
//                    u8 respawnIn, u8 invulnerable (десяті с), f32 cooldown (точно — від нього
//                    залежить передбачення пострілу), u8 shield, u8 rapid, u8 homing (десяті с),
//                    u32 score, u16 deaths
//    bullet (+10):   u8 team, u8 homing, u32 ownerId (0 — немає), u32 spawnSeq (0 — немає)
//    asteroid (+3):  u8 size, u8 variant, u8 homing
//    pickup (+2):    u8 effect (0 shield, 1 rapid, 2 homing), u8 ttl (десяті с)
//   Подія — фіксовано 18 байтів:
//    u8 type (1 fired 2 hit 3 exploded 4 pickup 5 score), f32 x, f32 y, u8 team, u8 a, u8 size,
//    u32 shipId (0 — немає), u16 value.  a: fired→homing; hit→target (0 ship 1 asteroid);
//    exploded→kind (1 ship 3 asteroid); pickup→effect.  value: score→delta.
//  team: 0 player, 1 enemy, 2 neutral.
//
//  Lab 6: кодер перевіряє діапазони (hp > 255 → RangeError, а не тихе обрізання байта),
//  декодер — довжину, тип, версію і кожне значення enum. Сміття → DecodeError, не "будь-що".
// =====================================================================

import {
  EFFECT_NAMES,
  assertNever,
  isEntityId,
  toEntityId,
  toSeq,
  toTick,
  type EffectName,
  type EntityId,
  type Seq,
  type Team,
} from '../types.ts'
import type { EntityData, InputMsg, Snapshot } from '../protocol.ts'
import type { GameEvent } from '../events.ts'
import { isAsteroidSize } from '../sim/asteroid.ts'

export const MSG = Object.freeze({ INPUT: 1, SNAPSHOT: 2 })
export const VERSION = 1

export class DecodeError extends Error {
  override name = 'DecodeError'
}

const TEAMS: readonly Team[] = ['player', 'enemy', 'neutral']
const KINDS: readonly EntityData['kind'][] = ['ship', 'bullet', 'asteroid', 'pickup']
const EVENTS: readonly GameEvent['type'][] = ['fired', 'hit', 'exploded', 'pickup', 'score']
const ENTITY_SIZE: Readonly<Record<EntityData['kind'], number>> = {
  ship: 42,
  bullet: 25,
  asteroid: 18,
  pickup: 17,
}
const HEADER = 17
const EVENT_SIZE = 18
const TAU = Math.PI * 2

function packAngle(a: number): number {
  a = ((a % TAU) + TAU) % TAU // [0, 2π)
  if (a > Math.PI) a -= TAU // [-π, π]
  return Math.round(a * 1000)
}
const deci = (s: number): number => Math.min(255, Math.round(s * 10))

// ---------- запис з перевіркою діапазонів ----------
class Writer {
  readonly buffer: ArrayBuffer // зберігаємо сам буфер: view.buffer типізований ширше (може бути SharedArrayBuffer)
  readonly view: DataView
  #o = 0
  constructor(size: number) {
    this.buffer = new ArrayBuffer(size)
    this.view = new DataView(this.buffer)
  }
  #int(n: number, min: number, max: number, what: string): number {
    if (!Number.isInteger(n) || n < min || n > max)
      throw new RangeError(`${what}: ${n} is out of [${min}, ${max}]`)
    return n
  }
  u8(n: number, what = 'u8'): void {
    this.view.setUint8(this.#o, this.#int(n, 0, 255, what))
    this.#o += 1
  }
  i8(n: number, what = 'i8'): void {
    this.view.setInt8(this.#o, this.#int(n, -128, 127, what))
    this.#o += 1
  }
  u16(n: number, what = 'u16'): void {
    this.view.setUint16(this.#o, this.#int(n, 0, 0xffff, what), true)
    this.#o += 2
  }
  i16(n: number, what = 'i16'): void {
    this.view.setInt16(this.#o, this.#int(n, -0x8000, 0x7fff, what), true)
    this.#o += 2
  }
  u32(n: number, what = 'u32'): void {
    this.view.setUint32(this.#o, this.#int(n, 0, 0xffffffff, what), true)
    this.#o += 4
  }
  f32(n: number, what = 'f32'): void {
    if (!Number.isFinite(n)) throw new RangeError(`${what}: ${n} is not finite`)
    this.view.setFloat32(this.#o, n, true)
    this.#o += 4
  }
}

// ---------- читання з перевіркою меж ----------
class Reader {
  readonly #view: DataView
  #o = 0
  constructor(view: DataView) {
    this.#view = view
  }
  #need(n: number): number {
    if (this.#o + n > this.#view.byteLength) throw new DecodeError(`truncated message at byte ${this.#o}`)
    const at = this.#o
    this.#o += n
    return at
  }
  u8(): number {
    return this.#view.getUint8(this.#need(1))
  }
  i8(): number {
    return this.#view.getInt8(this.#need(1))
  }
  u16(): number {
    return this.#view.getUint16(this.#need(2), true)
  }
  i16(): number {
    return this.#view.getInt16(this.#need(2), true)
  }
  u32(): number {
    return this.#view.getUint32(this.#need(4), true)
  }
  f32(): number {
    return this.#view.getFloat32(this.#need(4), true)
  }
  get remaining(): number {
    return this.#view.byteLength - this.#o
  }
}

function pick<T>(list: readonly T[], i: number, what: string): T {
  const v = list[i]
  if (v === undefined) throw new DecodeError(`bad ${what} code ${i}`)
  return v
}
const optionalId = (n: number): EntityId | null => (n === 0 ? null : toEntityId(n))
function requiredId(n: number, what: string): EntityId {
  if (n === 0 || !isEntityId(n)) throw new DecodeError(`${what}: missing ship id`)
  return n
}
const teamCode = (t: Team): number => TEAMS.indexOf(t)
const effectCode = (e: EffectName): number => EFFECT_NAMES.indexOf(e)

// Buffer у Node — це Uint8Array, що може дивитися в СЕРЕДИНУ більшого ArrayBuffer (пул).
// Тому обов'язково враховуємо byteOffset, інакше читатимемо чужі байти.
function asView(bytes: ArrayBuffer | ArrayBufferView): DataView {
  if (bytes instanceof ArrayBuffer) return new DataView(bytes)
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function header(r: Reader, expected: number, name: string): void {
  const type = r.u8()
  const version = r.u8()
  if (type !== expected) throw new DecodeError(`expected ${name} (type ${expected}), got type ${type}`)
  if (version !== VERSION) throw new DecodeError(`${name} version ${version}, expected ${VERSION}`)
}

// ---------- INPUT ----------

export function encodeInput(m: InputMsg): ArrayBuffer {
  const w = new Writer(8)
  w.u8(MSG.INPUT)
  w.u8(VERSION)
  w.u32(m.seq, 'seq')
  w.i8(m.turn, 'turn')
  w.u8((m.thrust ? 1 : 0) | (m.fire ? 2 : 0))
  return w.buffer
}

export function decodeInput(bytes: ArrayBuffer | ArrayBufferView): InputMsg {
  const view = asView(bytes)
  if (view.byteLength !== 8) throw new DecodeError(`input must be 8 bytes, got ${view.byteLength}`)
  const r = new Reader(view)
  header(r, MSG.INPUT, 'input')
  const seq = toSeq(r.u32())
  const turn = r.i8()
  if (turn !== -1 && turn !== 0 && turn !== 1) throw new DecodeError(`bad turn ${turn}`) // звужує тип до -1 | 0 | 1
  const buttons = r.u8()
  if (buttons > 3) throw new DecodeError(`bad buttons ${buttons}`)
  return { type: 'input', seq, turn, thrust: (buttons & 1) !== 0, fire: (buttons & 2) !== 0 }
}

// ---------- SNAPSHOT ----------

export function encodeSnapshot(s: Snapshot): ArrayBuffer {
  let size = HEADER + s.events.length * EVENT_SIZE
  for (const e of s.entities) size += ENTITY_SIZE[e.kind]
  const w = new Writer(size)
  w.u8(MSG.SNAPSHOT)
  w.u8(VERSION)
  w.u32(s.tick, 'tick')
  w.u32(s.ack, 'ack')
  w.u32(s.you ?? 0, 'you')
  w.u16(s.entities.length, 'entityCount')
  w.u8(s.events.length, 'eventCount')

  for (const e of s.entities) {
    w.u32(e.id, 'id')
    w.u8(KINDS.indexOf(e.kind) + 1)
    w.f32(e.x, 'x')
    w.f32(e.y, 'y')
    w.i16(packAngle(e.angle), 'angle')
    switch (e.kind) {
      case 'ship':
        w.u8(teamCode(e.team))
        w.f32(e.vx, 'vx')
        w.f32(e.vy, 'vy')
        w.u8(e.hp, 'hp')
        w.u8(e.maxHp, 'maxHp')
        w.u8(e.thrust ? 1 : 0)
        w.u8(deci(e.respawnIn))
        w.u8(deci(e.invulnerable))
        w.f32(e.cooldown, 'cooldown')
        w.u8(deci(e.effects.shield))
        w.u8(deci(e.effects.rapid))
        w.u8(deci(e.effects.homing))
        w.u32(e.score, 'score')
        w.u16(e.deaths, 'deaths')
        break
      case 'bullet':
        w.u8(teamCode(e.team))
        w.u8(e.homing ? 1 : 0)
        w.u32(e.ownerId ?? 0, 'ownerId')
        w.u32(e.spawnSeq ?? 0, 'spawnSeq')
        break
      case 'asteroid':
        w.u8(e.size)
        w.u8(e.variant, 'variant')
        w.u8(e.homing ? 1 : 0)
        break
      case 'pickup':
        w.u8(effectCode(e.effect))
        w.u8(deci(e.ttl))
        break
      default:
        assertNever(e, 'entity kind')
    }
  }

  for (const ev of s.events) {
    w.u8(EVENTS.indexOf(ev.type) + 1)
    w.f32(ev.x, 'event.x')
    w.f32(ev.y, 'event.y')
    switch (ev.type) {
      case 'fired':
        w.u8(teamCode(ev.team))
        w.u8(ev.homing ? 1 : 0)
        w.u8(0)
        w.u32(ev.shipId)
        w.u16(0)
        break
      case 'hit':
        w.u8(teamCode(ev.team))
        w.u8(ev.target === 'asteroid' ? 1 : 0)
        w.u8(0)
        w.u32(ev.shipId ?? 0)
        w.u16(0)
        break
      case 'exploded':
        w.u8(teamCode(ev.team))
        w.u8(ev.kind === 'asteroid' ? 3 : 1)
        w.u8(ev.size, 'size')
        w.u32(ev.shipId ?? 0)
        w.u16(0)
        break
      case 'pickup':
        w.u8(0)
        w.u8(effectCode(ev.effect))
        w.u8(0)
        w.u32(ev.shipId)
        w.u16(0)
        break
      case 'score':
        w.u8(0)
        w.u8(0)
        w.u8(0)
        w.u32(ev.shipId)
        w.u16(ev.delta, 'delta')
        break
      default:
        assertNever(ev, 'event type')
    }
  }
  return w.buffer
}

// Lab 7, M3: знімок для N клієнтів відрізняється лише двома полями заголовка — ack і you.
// Профіль сервера показав, що кодування того самого знімка N разів — гаряча точка (≈19% CPU).
// Тепер тіло кодуємо ОДИН раз, а кожному клієнту — копія з підставленими ack/you.
const ACK_OFFSET = 6
const YOU_OFFSET = 10
export function withSnapshotHeader(template: ArrayBuffer, ack: Seq, you: EntityId | null): ArrayBuffer {
  const copy = template.slice(0) // ~1–2 КБ memcpy — у сотні разів дешевше за повторне кодування
  const view = new DataView(copy)
  view.setUint32(ACK_OFFSET, ack, true)
  view.setUint32(YOU_OFFSET, you ?? 0, true)
  return copy
}

function readEntity(r: Reader): EntityData {
  const id = toEntityId(r.u32())
  const kind = pick(KINDS, r.u8() - 1, 'entity kind')
  const x = r.f32()
  const y = r.f32()
  const angle = r.i16() / 1000
  switch (kind) {
    case 'ship': {
      const team = pick(TEAMS, r.u8(), 'team')
      const vx = r.f32()
      const vy = r.f32()
      const hp = r.u8()
      const maxHp = r.u8()
      const thrust = r.u8() === 1
      const respawnIn = r.u8() / 10
      const invulnerable = r.u8() / 10
      const cooldown = r.f32()
      const effects = { shield: r.u8() / 10, rapid: r.u8() / 10, homing: r.u8() / 10 }
      const score = r.u32()
      const deaths = r.u16()
      return {
        id,
        kind,
        x,
        y,
        angle,
        team,
        vx,
        vy,
        hp,
        maxHp,
        thrust,
        respawnIn,
        invulnerable,
        cooldown,
        effects,
        score,
        deaths,
      }
    }
    case 'bullet': {
      const team = pick(TEAMS, r.u8(), 'team')
      const homing = r.u8() === 1
      const ownerId = optionalId(r.u32())
      const seq = r.u32()
      return { id, kind, x, y, angle, team, homing, ownerId, spawnSeq: seq === 0 ? null : toSeq(seq) }
    }
    case 'asteroid': {
      const size = r.u8()
      if (!isAsteroidSize(size)) throw new DecodeError(`bad asteroid size ${size}`)
      return { id, kind, x, y, angle, size, variant: r.u8(), homing: r.u8() === 1 }
    }
    case 'pickup':
      return { id, kind, x, y, angle, effect: pick(EFFECT_NAMES, r.u8(), 'effect'), ttl: r.u8() / 10 }
    default:
      return assertNever(kind, 'entity kind')
  }
}

function readEvent(r: Reader): GameEvent {
  const type = pick(EVENTS, r.u8() - 1, 'event type')
  const x = r.f32()
  const y = r.f32()
  const teamByte = r.u8()
  const a = r.u8()
  const size = r.u8()
  const shipId = r.u32()
  const value = r.u16()
  switch (type) {
    case 'fired':
      return {
        type,
        x,
        y,
        team: pick(TEAMS, teamByte, 'team'),
        shipId: requiredId(shipId, type),
        homing: a === 1,
      }
    case 'hit':
      return {
        type,
        x,
        y,
        team: pick(TEAMS, teamByte, 'team'),
        shipId: optionalId(shipId),
        target: a === 1 ? 'asteroid' : 'ship',
      }
    case 'exploded':
      return {
        type,
        x,
        y,
        team: pick(TEAMS, teamByte, 'team'),
        shipId: optionalId(shipId),
        kind: a === 3 ? 'asteroid' : 'ship',
        size,
      }
    case 'pickup':
      return { type, x, y, shipId: requiredId(shipId, type), effect: pick(EFFECT_NAMES, a, 'effect') }
    case 'score':
      return { type, x, y, shipId: requiredId(shipId, type), delta: value }
    default:
      return assertNever(type, 'event type')
  }
}

export function decodeSnapshot(bytes: ArrayBuffer | ArrayBufferView): Snapshot {
  const r = new Reader(asView(bytes))
  header(r, MSG.SNAPSHOT, 'snapshot')
  const tick = toTick(r.u32())
  const ack = toSeq(r.u32())
  const you = optionalId(r.u32())
  const count = r.u16()
  const eventCount = r.u8()
  const entities: EntityData[] = []
  for (let i = 0; i < count; i++) entities.push(readEntity(r))
  const events: GameEvent[] = []
  for (let i = 0; i < eventCount; i++) events.push(readEvent(r))
  if (r.remaining !== 0) throw new DecodeError(`${r.remaining} unexpected trailing bytes`)
  return { type: 'snapshot', tick, ack, you, entities, events }
}
