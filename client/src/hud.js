import { EFFECTS } from '../../shared/src/sim/components.js'

// HUD — теж підписник подій світу, як і звук. Сам світ про HUD не знає.
// Спливаючі "+50" і банер бонусу живуть у реальному часі (performance.now),
// а не в кроках симуляції: це прикраса, детермінізм їй не потрібен.

const POPUP_MS = 900
const BANNER_MS = 1600

export function createHud() {
  let popups = []
  let banner = null
  let scoreFlash = 0

  function attach(world) {
    const onScore = (e) => {
      const { delta, x, y } = e.detail
      popups.push({ text: `+${delta}`, x, y, born: performance.now() })
      scoreFlash = performance.now()
    }
    const onPickup = (e) => {
      banner = {
        text: `${EFFECTS[e.detail.effect].label}!`,
        color: EFFECTS[e.detail.effect].color,
        born: performance.now(),
      }
    }
    world.addEventListener('score', onScore)
    world.addEventListener('pickup', onPickup)
    return () => {
      world.removeEventListener('score', onScore)
      world.removeEventListener('pickup', onPickup)
    }
  }

  function draw(
    ctx,
    { stats, world, player, paused, playerName, soundState, toScreen = (x, y) => ({ x, y }) },
  ) {
    const now = performance.now()
    const w = ctx.canvas.clientWidth
    const h = ctx.canvas.clientHeight

    // спливаючі очки над місцем, де щось збили
    popups = popups.filter((p) => now - p.born < POPUP_MS)
    ctx.textAlign = 'center'
    ctx.font = 'bold 16px monospace'
    for (const p of popups) {
      const t = (now - p.born) / POPUP_MS
      ctx.globalAlpha = 1 - t
      ctx.fillStyle = '#ffe066'
      const sp = toScreen(p.x, p.y) // очки "спливають" над місцем у світі, а світ масштабовано камерою
      ctx.fillText(p.text, sp.x, sp.y - 20 - t * 30)
    }
    ctx.globalAlpha = 1

    // ліворуч: технічна статистика
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = 'white'
    ctx.font = '14px monospace'
    ctx.fillText(`steps/s: ${stats.stepsPerSec}`, 10, 20)
    ctx.fillText(`frames/s: ${stats.framesPerSec}`, 10, 40)
    ctx.fillText(`frame ms: ${stats.frameMs.toFixed(2)}`, 10, 60)
    ctx.fillStyle = '#9ca3af'
    ctx.fillText(`entities: ${world.size}`, 10, 80)
    ctx.fillText(`${world.arena.name} · ${playerName}`, 10, 100)

    // праворуч: очки (блимають при зміні), здоров'я, бонуси
    const right = w - 10
    const flash = Math.max(0, 1 - (now - scoreFlash) / 300)
    ctx.textAlign = 'right'
    ctx.font = `bold ${20 + Math.round(flash * 4)}px monospace`
    ctx.fillStyle = flash > 0 ? '#ffe066' : 'white'
    ctx.fillText(`SCORE ${player.score ?? world.score}`, right, 26)
    ctx.font = '16px monospace'
    ctx.fillStyle = '#ff5c5c'
    ctx.fillText('♥'.repeat(player.hp) + '♡'.repeat(player.maxHp - player.hp), right, 48)
    ctx.fillStyle = '#9ca3af'
    ctx.font = '13px monospace'
    ctx.fillText(`deaths: ${player.deaths ?? world.deaths}`, right, 66)
    let y = 88
    for (const [name, left] of player.effects) {
      ctx.fillStyle = EFFECTS[name].color
      ctx.fillText(`${EFFECTS[name].label} ${left.toFixed(1)}s`, right, y)
      y += 18
    }

    // знизу: підказка і стан звуку
    const sound = { running: '♪ on', muted: '♪ muted', suspended: '♪ click to enable', unsupported: '♪ n/a' }
    ctx.textAlign = 'left'
    ctx.fillStyle = '#6b7280'
    ctx.font = '13px monospace'
    ctx.fillText(
      `WASD / стрілки — літати · Пробіл — стріляти · P — пауза · M — звук (${sound[soundState] ?? soundState}) · N — нетграф · Esc — лобі`,
      10,
      h - 12,
    )

    // по центру: банер бонусу, респаун, пауза
    ctx.textAlign = 'center'
    if (banner && now - banner.born < BANNER_MS) {
      ctx.globalAlpha = 1 - (now - banner.born) / BANNER_MS
      ctx.fillStyle = banner.color
      ctx.font = 'bold 32px monospace'
      ctx.fillText(banner.text, w / 2, h / 2 - 90)
      ctx.globalAlpha = 1
    }
    ctx.font = 'bold 28px monospace'
    ctx.fillStyle = 'white'
    if (player.isWaitingRespawn) ctx.fillText(`RESPAWN ${player.respawnIn.toFixed(1)}`, w / 2, h / 2)
    if (paused) ctx.fillText('PAUSED', w / 2, h / 2 - 40)
  }

  return { attach, draw }
}
