import { World } from '../../../shared/src/sim/world.js'
import { Ship } from '../../../shared/src/sim/ship.js'
import { populateArena } from '../../../shared/src/sim/spawner.js'
import { ARENA_SIZE } from '../../../shared/src/sim/arena.js'
import { SIM_DT } from '../../../shared/src/sim/ship-physics.js'
import { botCommand } from './commands.js'

// Одиночна гра (офлайн-лобі: Live Server, GitHub Pages, немає сервера).
// Той самий спільний світ, що й на сервері, лише крутиться локально.
export class OfflineGame {
  constructor({ arena, bot = false }) {
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
    this.seq = 0
    this.online = false
  }

  // події світу (звук, HUD) — сам світ і є EventTarget
  get events() {
    return this.world
  }

  step(cmd) {
    if (this.bot) cmd = botCommand(this.player.motionState(), this.#targets(), this.seq)
    this.world.step(SIM_DT, new Map([[this.player.id, { ...cmd, seq: ++this.seq }]]))
  }

  #targets() {
    const out = []
    for (const e of this.world)
      if ((e.kind === 'ship' && e.team === 'enemy') || e.kind === 'asteroid') out.push(e.pos)
    return out
  }

  // що малювати: сам світ (у сутностей є prevPos/pos — інтерполяція між кроками через alpha)
  view() {
    return this.world
  }

  get me() {
    return this.player
  }

  get hudWorld() {
    return { size: this.world.size, arena: this.world.arena }
  }

  close() {}
}
