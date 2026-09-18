import { createLoop } from './loop.js'
import { createInput } from './input.js'
import { createShip, integrate } from './sim/ship.js'
import { wrapAround } from './sim/arena.js'
import { setupCanvas } from './render/canvas.js'
import { drawShip, drawHud } from './render/draw.js'

const canvas = document.getElementById('game')
const ctx = setupCanvas(canvas)

const input = createInput(window)
const ship = createShip()
let previousShip = { ...ship }

function simulate(dt) {
  previousShip = { ...ship }
  integrate(ship, input, dt)
  const { wrappedX, wrappedY } = wrapAround(ship, window.innerWidth, window.innerHeight)
  if (wrappedX) previousShip.x = ship.x   
  if (wrappedY) previousShip.y = ship.y   
}

function render(alpha) {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
  drawShip(ctx, previousShip, ship, alpha)
  drawHud(ctx, loop.stats)
}

const loop = createLoop({ simulate, render })
loop.start()