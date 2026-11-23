import type { Command } from '@conter/shared/sim/ship-physics.ts'
import type { InputMsg } from '@conter/shared/protocol.ts'

// Lab 7: джерело команд для літака. Людина (команди з мережі) і бот (AI на сервері)
// реалізують ОДИН інтерфейс — матч не знає і не має знати, хто керує літаком.
export interface PlayerInput {
  readonly kind: 'human' | 'bot'
  // команди на ОДИН крок симуляції: зазвичай одна; кілька — наздоганяємо після затримки;
  // жодної — команда ще не дійшла (літак чекає, SKIP)
  take(): readonly Command[]
}

export interface InputStats {
  droppedInputs: number
  starvedSteps: number
  catchUpSteps: number
}

const MAX_QUEUE = 30 // ~0.5 с команд наперед; більше — клієнт шле занадто часто (спідхак)
const JITTER_BUFFER = 2 // скільки команд тримаємо в запасі проти джитера
const MAX_CREDIT = 10 // скільки "пропущених" кроків можна наздогнати

// Команди людини, що прийшли мережею (логіка Lab 5, перенесена з Match без змін):
// одна команда = один крок; не дійшла — кредит; прийшли пачкою — витрачаємо кредит.
export class NetworkInput implements PlayerInput {
  readonly kind = 'human'
  readonly #stats: InputStats
  #queue: InputMsg[] = []
  #lastQueuedSeq = 0
  #credit = 0

  constructor(stats: InputStats) {
    this.#stats = stats
  }

  // команда вже перевірена protocol.ts/codec; тут — лише порядок і ліміт черги
  push(cmd: InputMsg): boolean {
    if (cmd.seq <= this.#lastQueuedSeq) return false // дубль або застаріла
    if (this.#queue.length >= MAX_QUEUE) {
      this.#stats.droppedInputs++
      return false
    }
    this.#lastQueuedSeq = cmd.seq
    this.#queue.push(cmd)
    return true
  }

  take(): readonly Command[] {
    const cmds: Command[] = []
    const first = this.#queue.shift()
    if (first) cmds.push(first)
    else {
      this.#credit = Math.min(MAX_CREDIT, this.#credit + 1)
      this.#stats.starvedSteps++
    }
    while (this.#queue.length > JITTER_BUFFER && this.#credit > 0) {
      const extra = this.#queue.shift()
      if (!extra) break
      cmds.push(extra)
      this.#credit--
      this.#stats.catchUpSteps++
    }
    return cmds
  }
}
