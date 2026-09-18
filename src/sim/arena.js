export function wrapAround(ship, width, height) {
  let wrappedX = false
  let wrappedY = false

  if (ship.x < 0)     { ship.x = width;  wrappedX = true }
  if (ship.x > width) { ship.x = 0;      wrappedX = true }
  if (ship.y < 0)      { ship.y = height; wrappedY = true }
  if (ship.y > height) { ship.y = 0;      wrappedY = true }

  return { wrappedX, wrappedY }
}