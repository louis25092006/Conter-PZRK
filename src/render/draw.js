function lerp(a, b, t) {
  return a + (b - a) * t
}

function lerpAngle(a, b, t) {
  let diff = b - a
  while (diff > Math.PI) diff -= 2 * Math.PI
  while (diff < -Math.PI) diff += 2 * Math.PI
  return a + diff * t
}

export function drawShip(ctx, previous, current, alpha) {
  const x = lerp(previous.x, current.x, alpha)
  const y = lerp(previous.y, current.y, alpha)
  const angle = lerpAngle(previous.angle, current.angle, alpha)

  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.fillStyle = 'white'
  ctx.beginPath()
  ctx.moveTo(15, 0)
  ctx.lineTo(-10, 10)
  ctx.lineTo(-10, -10)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

export function drawHud(ctx, stats) {
  ctx.fillStyle = 'white'
  ctx.font = '14px monospace'
  ctx.fillText(`steps/s: ${stats.stepsPerSec}`, 10, 20)
  ctx.fillText(`frames/s: ${stats.framesPerSec}`, 10, 40)
  ctx.fillText(`frame ms: ${stats.frameMs.toFixed(2)}`, 10, 60)
}