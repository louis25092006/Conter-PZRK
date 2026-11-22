import { createLoop } from './loop.js'
import { createInput } from './input.js'
import { createAudio } from './audio.js'
import { createHud } from './hud.js'
import { World } from './sim/world.js'
import { Ship } from './sim/ship.js'
import { populateArena } from './sim/spawner.js'
import { setupCanvas } from './render/canvas.js'
import { createStarfield, drawStarfield, drawWorld } from './render/draw.js'
import { drawLoadingScreen } from './render/loading.js'
import { createLobbyBackground } from './render/lobby-bg.js'
import { fetchJson, withRetry, loadAll, loadAllSequential, isAbort } from './assets/loader.js'
import { readTestFlags, applyTestFlags } from './assets/test-flags.js'
import { Lobby } from './lobby/lobby.js'
import { mountLobbyView } from './lobby/lobby-view.js'
import { Connection, socketUrl } from './net/connection.js'
import { mountRoomView } from './net/room-view.js'

// Сценарій гри:  завантаження → лобі → гра → (Esc) → лобі → …

const canvas = document.getElementById('game')
const ctx = setupCanvas(canvas)
const ui = document.getElementById('ui')
const gameUi = document.getElementById('game-ui')
const input = createInput(window)
const audio = createAudio()
const hud = createHud()
const flags = readTestFlags(location.search)
// import.meta.env існує лише під Vite; у Live Server / GitHub Pages його немає
const DEV = import.meta.env?.DEV ?? false

// браузер дозволяє звук лише після жесту користувача
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => audio.unlock())

let stars = createStarfield(window.innerWidth, window.innerHeight)
window.addEventListener('resize', () => {
  stars = createStarfield(window.innerWidth, window.innerHeight)
  if (game) {
    game.world.width = window.innerWidth
    game.world.height = window.innerHeight
  }
})

let assets = null // { images, sounds, json, frames, failed }
let game = null // { world, player, name, room, detach }

function button(text, onClick, className = '') {
  const b = Object.assign(document.createElement('button'), { textContent: text, className })
  b.addEventListener('click', onClick)
  return b
}

// ---------- 1. Завантаження ----------

async function boot(activeFlags) {
  const controller = new AbortController()
  const signal = controller.signal
  const screen = {
    phase: 'manifest',
    done: 0,
    total: 0,
    failed: [],
    retries: [],
    error: null,
    elapsedMs: 0,
    lastItem: '',
  }
  const started = performance.now()

  const actions = Object.assign(document.createElement('div'), { className: 'loading-actions' })
  actions.append(button('Cancel', () => controller.abort()))
  ui.className = ''
  ui.replaceChildren(actions)

  // екран малюємо в rAF: завантаження асинхронне і цикл подій не блокує
  let raf = requestAnimationFrame(function paint() {
    if (screen.phase === 'loading' || screen.phase === 'manifest')
      screen.elapsedMs = performance.now() - started
    drawLoadingScreen(ctx, screen)
    raf = requestAnimationFrame(paint)
  })

  if (activeFlags.has('abort')) setTimeout(() => controller.abort(), 1000)

  try {
    const { url: manifestUrl, data: raw } = await findManifest(signal)
    // адреси в маніфесті відносні (sprites/ships.svg) — рахуємо їх від папки, де знайшли маніфест
    const flagged = applyTestFlags(raw, activeFlags)
    const manifest = {
      ...flagged,
      items: flagged.items.map((item) => ({ ...item, url: new URL(item.url, manifestUrl).href })),
    }
    screen.phase = 'loading'
    screen.total = manifest.items.length

    const load = activeFlags.has('sequential') ? loadAllSequential : loadAll
    const t0 = performance.now()
    assets = await load(manifest, {
      audioCtx: audio.ctx,
      signal,
      timeoutMs: 5000,
      retry: { attempts: 3, baseMs: 300 },
      onRetry: (r) => screen.retries.push(r),
      onProgress: (p) => {
        screen.done = p.done
        screen.failed = p.failed
        screen.lastItem = `${p.ok ? '✓' : '⚠'} ${p.item.url}`
      },
    })
    const ms = performance.now() - t0
    console.info(
      `[loader] ${load.name}: ${manifest.items.length} items in ${ms.toFixed(0)} ms`,
      assets.failed,
    )
    audio.setBuffers(assets.sounds)
    screen.phase = 'done'
    screen.elapsedMs = ms
    cancelAnimationFrame(raf)
    drawLoadingScreen(ctx, screen)
    ui.replaceChildren()

    // якщо щось не завантажилось — даємо мить прочитати попередження
    setTimeout(showLobby, assets.failed.length ? 2000 : 300)
  } catch (error) {
    screen.phase = isAbort(error) ? 'cancelled' : 'error'
    screen.error = isAbort(error) ? null : error
    console.warn('[loader] failed:', error)
    // Retry = нова спроба без навмисних збоїв (наче мережа відновилась)
    actions.replaceChildren(
      button(
        'Retry',
        () => {
          cancelAnimationFrame(raf)
          boot(new Set())
        },
        'primary',
      ),
    )
  }
}

// Де лежать ассети, залежить від того, ЯК запущено гру:
//   Vite (npm run dev), наш Node-сервер, збірка dist  → /assets/manifest.json (public/ стає коренем сайту)
//   Live Server у VS Code, GitHub Pages, будь-який статичний сервер → ./public/assets/manifest.json
// Пробуємо по черзі; 404 означає "не тут", інші помилки — справжні.
async function findManifest(signal) {
  const candidates = ['assets/manifest.json', 'public/assets/manifest.json'].map(
    (p) => new URL(p, document.baseURI),
  )
  for (const [i, url] of candidates.entries()) {
    try {
      const data = await withRetry(() => fetchJson(url.href, { signal, timeoutMs: 4000 }), { signal })
      return { url, data }
    } catch (error) {
      const notHere = error.name === 'HttpError' && error.status === 404
      // статичний сервер на невідому адресу інколи віддає HTML-сторінку — теж "не тут"
      const htmlInsteadOfJson = error.name === 'AssetFormatError'
      if (i === candidates.length - 1 || !(notHere || htmlInsteadOfJson)) throw error
    }
  }
}

// ---------- 2. Лобі ----------

const lobby = new Lobby({
  url: flags.has('lobbyslow') ? '/api/rooms?delay=5000' : '/api/rooms',
  intervalMs: 4000,
  timeoutMs: 3000,
})
let unmountLobby = null
const lobbyBg = createLobbyBackground(ctx) // живе небо з літаками за панеллю лобі

function showLobby() {
  stopGame()
  ui.className = 'overlay'
  lobby.offlineRooms = Object.entries(assets.json.arenas).map(([id, arena]) => ({
    id: `offline-${id}`,
    name: arena.name,
    arena: id,
    players: 0,
    maxPlayers: 1,
    offline: true,
  }))
  unmountLobby = mountLobbyView(ui, lobby, { arenas: assets.json.arenas })
  lobby.open()
  lobbyBg.start()
  if (DEV) window.game = { lobby, assets, audio }
}

lobby.addEventListener('close', () => {
  lobbyBg.stop()
  unmountLobby?.()
  unmountLobby = null
  ui.className = ''
})

lobby.addEventListener('join', (e) => {
  audio.unlock() // клік "Join" — теж жест користувача
  startGame(e.detail.room, e.detail.name)
})

// ---------- 3. Гра ----------

let paused = false

function startGame(room, name) {
  const arena = assets.json.arenas[room.arena] ?? Object.values(assets.json.arenas)[0]
  const world = new World({ width: window.innerWidth, height: window.innerHeight, arena })
  const player = world.spawn(
    new Ship({
      team: 'player',
      controller: 'keyboard',
      x: world.width / 2,
      y: world.height / 2,
      angle: -Math.PI / 2,
    }),
  )
  populateArena(world)

  // підписники подій світу: звук і HUD. Самому світу про них знати не треба.
  const detachAudio = audio.attach(world)
  const detachHud = hud.attach(world)

  // Lab 4: справжнє з'єднання з кімнатою на сервері (поки що лише склад кімнати і чат;
  // сама гра лишається локальною — синхронізація світу буде в Lab 5).
  // join надсилаємо в onOpen, тому після перепідключення гравець сам повертається в кімнату.
  // В офлайн-режимі (немає сервера) з'єднання не відкриваємо: на Live Server за адресою /ws
  // взагалі живе його власний сокет автоперезавантаження, а не наш сервер.
  let conn = null
  let unmountRoom
  if (room.offline) {
    const note = Object.assign(document.createElement('div'), {
      className: 'net-status closed',
      textContent: '● офлайн: одиночна гра (чат працює з npm run dev)',
    })
    gameUi.replaceChildren(note)
    unmountRoom = () => gameUi.replaceChildren()
  } else {
    conn = new Connection(socketUrl('/ws'), {
      onOpen: (c) => c.send({ type: 'join', v: 0, roomId: room.id, name }),
    })
    unmountRoom = mountRoomView(gameUi, conn, { room })
    conn.connect()
  }

  game = {
    world,
    player,
    name,
    room,
    conn,
    detach: () => {
      detachAudio()
      detachHud()
      unmountRoom()
      conn?.close(1000, 'left the game')
    },
  }
  paused = false
  loop.start()
  if (DEV) window.game = { ...game, loop, lobby, assets, audio }
}

function stopGame() {
  if (!game) return
  loop.stop()
  game.detach()
  game = null
}

function simulate(dt) {
  if (input.justPressed('Escape')) {
    input.consume()
    showLobby()
    return
  }
  if (input.justPressed('KeyM')) audio.toggleMute()
  if (input.justPressed('KeyP')) paused = !paused // edge-triggered: одне натискання = одне перемикання
  if (!paused) game.world.step(dt, input)
  input.consume()
}

function render(alpha) {
  if (!game) return
  const { world, player } = game
  ctx.fillStyle = world.arena.sky ?? '#000'
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight)
  drawStarfield(ctx, stars)
  drawWorld(ctx, world, paused ? 1 : alpha, performance.now() / 1000, assets)
  hud.draw(ctx, { stats: loop.stats, world, player, paused, playerName: game.name, soundState: audio.state })
}

const loop = createLoop({ simulate, render })

boot(flags)
