import { stepShip, SIM_DT, type Command, type MotionState, type ShipParams } from '../sim/ship-physics.ts'
import type { Seq } from '../types.ts'

// Звірка передбачення (Lab 5), винесена в ЧИСТУ функцію (Lab 7): лише вхід → вихід,
// без сокетів, таймерів і стану NetGame — тож її можна перевірити звичайним тестом.
//
//   server  — стан мого літака зі знімка сервера (після команди №ack)
//   pending — мої команди, які сервер міг ще не обробити
//   ack     — номер останньої команди, яку сервер уже застосував
// Результат: де я маю бути зараз (стан сервера + повтор непідтверджених команд)
// і список команд, які лишаються непідтвердженими.

export interface PendingInput {
  readonly seq: Seq
  readonly cmd: Command
}

export interface ReconcileResult {
  readonly state: MotionState
  readonly pending: PendingInput[]
}

export function reconcile(
  server: Readonly<MotionState>,
  pending: readonly PendingInput[],
  ack: Seq,
  params: ShipParams,
  width: number,
  height: number,
): ReconcileResult {
  const left = pending.filter((p) => p.seq > ack)
  const state: MotionState = { ...server } // копія: вхідний стан не змінюємо
  for (const p of left) stepShip(state, p.cmd, params, SIM_DT, width, height)
  return { state, pending: left }
}
