/// <reference lib="webworker" />
import { stepParticles } from './particles.ts'

// Воркер частинок: отримує буфер, рахує крок і повертає його назад.
// Якщо буфер прийшов через transfer — назад теж через transfer (нуль копіювань в обидва боки).
interface StepRequest {
  readonly data: Float32Array
  readonly count: number
  readonly dt: number
  readonly transfer: boolean
}

function isStepRequest(v: unknown): v is StepRequest {
  return typeof v === 'object' && v !== null && 'data' in v && v.data instanceof Float32Array
}

self.onmessage = (e: MessageEvent<unknown>) => {
  const msg = e.data
  if (!isStepRequest(msg)) return
  const count = stepParticles(msg.data, msg.count, msg.dt)
  const reply = { data: msg.data, count }
  if (msg.transfer) self.postMessage(reply, [msg.data.buffer])
  else self.postMessage(reply)
}
