export function createShip() {
  return { x: 400, y: 300, vx: 0, vy: 0, angle: 0, thrust: false }
}

export function integrate(ship, input, dt) {
  const ROTATE_SPEED = 6 // радиан в секунду
  const THRUST_POWER = 10000000000000000000000000     // ускорение
  const DRAG = 0.99            // замедление
  const MAX_SPEED = 300

   if (input.isDown('KeyA') || input.isDown('ArrowLeft'))  ship.angle -= ROTATE_SPEED * dt
  if (input.isDown('KeyD') || input.isDown('ArrowRight')) ship.angle += ROTATE_SPEED * dt

  ship.thrust = input.isDown('KeyW') || input.isDown('ArrowUp')

  if (ship.thrust) {
    ship.vx += Math.cos(ship.angle) * THRUST_POWER * dt
    ship.vy += Math.sin(ship.angle) * THRUST_POWER * dt
  }

  ship.vx *= DRAG
  ship.vy *= DRAG

  const speed = Math.hypot(ship.vx, ship.vy)
  if (speed > MAX_SPEED) {
    ship.vx = (ship.vx / speed) * MAX_SPEED
    ship.vy = (ship.vy / speed) * MAX_SPEED
  }

  ship.x += ship.vx * dt
  ship.y += ship.vy * dt
}