import { createLoop } from './loop.js'
import { createInput } from './input.js'
import { World } from './sim/world.js'
import { Ship } from './sim/ship.js'
import { spawnAsteroid } from './sim/spawner.js'
import { setupCanvas } from './render/canvas.js'
import { createStarfield, drawStarfield, drawWorld, drawHud } from './render/draw.js'

const canvas = document.getElementById('game')
const ctx = setupCanvas(canvas)
const input = createInput(window)

const world = new World({ width: window.innerWidth, height: window.innerHeight, seed: 2026 })
const player = world.spawn(
  new Ship({
    team: 'player',
    controller: 'keyboard',
    x: world.width / 2,
    y: world.height / 2,
    angle: -Math.PI / 2,
  }),
)
for (let i = 0; i < 2; i++) spawnAsteroid(world, 3)

let stars = createStarfield(world.width, world.height)
window.addEventListener('resize', () => {
  world.width = window.innerWidth
  world.height = window.innerHeight
  stars = createStarfield(world.width, world.height)
})

let paused = false

function simulate(dt) {
  if (input.justPressed('KeyP')) paused = !paused // edge-triggered: одне натискання = одне перемикання
  if (!paused) world.step(dt, input)
  input.consume()
}

function render(alpha) {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
  drawStarfield(ctx, stars)
  drawWorld(ctx, world, paused ? 1 : alpha, performance.now() / 1000)
  drawHud(ctx, loop.stats, world, player, paused)
}

const loop = createLoop({ simulate, render })
loop.start()

// доступ із консолі DevTools для експериментів (тільки в dev-режимі)
if (import.meta.env.DEV) window.game = { world, player, loop }
