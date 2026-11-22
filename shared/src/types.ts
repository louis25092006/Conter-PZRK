// Базові типи, спільні для клієнта і сервера.

// ---------- "Брендовані" числа ----------
// EntityId, Tick і Seq — усі просто числа, і JavaScript їх не розрізняє.
// Бренд — це "наліпка" лише для компілятора: передати Tick туди, де чекають EntityId,
// стане помилкою компіляції, хоча в рантаймі це те саме число (нуль витрат).
declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type EntityId = Brand<number, 'EntityId'> // id сутності у світі
export type Tick = Brand<number, 'Tick'> // номер тіку сервера (30/с)
export type Seq = Brand<number, 'Seq'> // номер команди гравця (60/с)

const isU32 = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff

// "Ворота" в брендовані типи: функція-предикат (n is EntityId) звужує тип без жодного `as`.
export function isEntityId(n: unknown): n is EntityId {
  return typeof n === 'number' && isU32(n)
}
export function isTick(n: unknown): n is Tick {
  return typeof n === 'number' && isU32(n)
}
export function isSeq(n: unknown): n is Seq {
  return typeof n === 'number' && isU32(n)
}

function brandOrThrow<T>(n: number, check: (n: unknown) => n is T, name: string): T {
  if (!check(n)) throw new RangeError(`${name} must be a uint32, got ${n}`)
  return n
}
export const toEntityId = (n: number): EntityId => brandOrThrow(n, isEntityId, 'EntityId')
export const toTick = (n: number): Tick => brandOrThrow(n, isTick, 'Tick')
export const toSeq = (n: number): Seq => brandOrThrow(n, isSeq, 'Seq')

// ---------- Result: помилка — це значення, а не виняток ----------
// Для даних ззовні (мережа, файли): погане повідомлення — нормальна ситуація,
// її обробляють if-ом, а не try/catch, і компілятор не дасть забути гілку з помилкою.
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

// ---------- Вичерпність ----------
// Останній default у switch за `type` чи `kind`. Якщо додати новий варіант у union
// і забути його обробити — тут буде помилка компіляції ("не можна передати X у never").
export function assertNever(x: never, what = 'value'): never {
  throw new Error(`Unexpected ${what}: ${JSON.stringify(x)}`)
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export type Team = 'player' | 'enemy' | 'neutral'
export type EffectName = 'shield' | 'rapid' | 'homing'
export const EFFECT_NAMES: readonly EffectName[] = ['shield', 'rapid', 'homing']
