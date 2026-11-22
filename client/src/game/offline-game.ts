import { World } from '../../../shared/src/sim/world.ts'
import { Ship } from '../../../shared/src/sim/ship.ts'
import { populateArena } from '../../../shared/src/sim/spawner.ts'
import { ARENA_SIZE } from '../../../shared/src/sim/arena.ts'
import { SIM_DT } from '../../../shared/src/sim/ship-physics.ts'
import type { Point } from '../../../shared/src/sim/vector.ts'
import type { Bus } from '../../../shared/src/bus.ts'
import type { GameEvents } from '../../../shared/src/events.ts'
import type { ArenaConfig } from '../../../shared/src/arena-config.ts'
import { toSeq } from '../../../shared/src/types.ts'
import { botCommand, type PlayerCommand } from './commands.ts'
import type { Scene } from '../render/draw.ts'
import type { HudPlayer, HudWorld } from '../hud.ts'

// Одиночна гра (офлайн-лобі: Live Server, GitHub Pages, немає сервера).
// Той самий спільний світ, що й на сервері, лише крутиться локально.
export class OfflineGame {
  readonly online = false
  readonly world: World
  readonly player: Ship
  readonly bot: boolean
  seq = 0

  constructor({ arena, bot = false }: { arena: ArenaConfig; bot?: boolean }) {
    this.world = new World({ ...ARENA_SIZE, arena })
    this.player = this.world.spawn(
      new Ship({
        team: 'player',
        controller: 'input',
        x: ARENA_SIZE.width / 2,
        y: ARENA_SIZE.height / 2,
        angle: -Math.PI / 2,
      }),
    )
    populateArena(this.world)
    this.bot = bot
  }

  // події світу (звук, HUD) — типізована шина самого світу
  get events(): Bus<GameEvents> {
    return this.world.events
  }

  step(input: PlayerCommand): void {
    const cmd = this.bot ? botCommand(this.player.motionState(), this.#targets(), this.seq) : input
    this.world.step(SIM_DT, new Map([[this.player.id, { ...cmd, seq: toSeq(++this.seq) }]]))
  }

  #targets(): Point[] {
    const out: Point[] = []
    for (const e of this.world)
      if ((e.kind === 'ship' && e.team === 'enemy') || e.kind === 'asteroid') out.push(e.pos)
    return out
  }

  // що малювати: сам світ (у сутностей є prevPos/pos — інтерполяція між кроками через alpha)
  view(): Scene {
    const w = this.world
    // getter-и: кожен шар — свіжий генератор по світу, нічого не копіюємо
    return {
      get ship() {
        return w.ofKind('ship')
      },
      get bullet() {
        return w.ofKind('bullet')
      },
      get asteroid() {
        return w.ofKind('asteroid')
      },
      get pickup() {
        return w.ofKind('pickup')
      },
      get explosion() {
        return w.ofKind('explosion')
      },
    }
  }

  get me(): HudPlayer {
    return this.player
  }

  get hudWorld(): HudWorld {
    return { size: this.world.size, arena: this.world.arena }
  }

  close(): void {}
}
