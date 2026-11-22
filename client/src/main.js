import { createLoop } from './loop.js'
import { createInput } from './input.js'
import { createAudio } from './audio.js'
import { createHud } from './hud.js'
import { setupCanvas } from './render/canvas.js'
import { createStarfield, drawStarfield, drawWorld } from './render/draw.js'
import { drawLoadingScreen } from './render/loading.js'
import { createLobbyBackground } from './render/lobby-bg.js'
import { fetchJson, withRetry, loadAll, loadAllSequential, isAbort } from './assets/loader.js'
import { readTestFlags, applyTestFlags } from './assets/test-flags.js'
import { Lobby } from './lobby/lobby.js'
import { mountLobbyView } from './lobby/lobby-view.js'
import { mountRoomView } from './net/room-view.js'
import { NetGame } from './net/net-game.js'
import { drawNetgraph, mountNetControls } from './net/netgraph.js'
import { OfflineGame } from './game/offline-game.js'
import { keyboardCommand } from './game/commands.js'
import { computeCamera, drawArenaBackground, drawArenaBorder } from './game/camera.js'
import { ARENA_SIZE } from '../../shared/src/sim/arena.js'
import { debug as simDebug } from '../../shared/src/sim/ship-physics.js'

// Сценарій гри:  завантаження → лобі → гра → (Esc) → лобі → …

const canvas = document.getElementById('game')
const ctx = setupCanvas(canvas)
const ui = document.getElementById('ui')
const gameUi = document.getElementById('game-ui')
const input = createInput(window)
const audio = createAudio()
const hud = createHud()
const flags = readTestFlags(location.search)
const params = new URLSearchParams(location.search)
// Lab 5, дослід M2: ?test=nondet — навмисно зламати детермінізм передбачення (лише на клієнті)
if (flags.has('nondet')) simDebug.breakDeterminism = true
// import.meta.env існує лише під Vite; у Live Server / GitHub Pages його немає
const DEV = import.meta.env?.DEV ?? false

// браузер дозволяє звук лише після жесту користувача
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => audio.unlock())

// зорі — у координатах арени (вона тепер фіксована), камера масштабує їх разом зі світом
const stars = createStarfield(ARENA_SIZE.width, ARENA_SIZE.height, 260)

let assets = null // { images, sounds, json, frames, failed }
let game = null // OfflineGame | NetGame

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
//
// Два режими з однаковим інтерфейсом { step(cmd), view(alpha), me, hudWorld, events, close() }:
//   OfflineGame — світ крутиться локально (немає сервера: Live Server, GitHub Pages);
//   NetGame     — сервер авторитетний; клієнт передбачає, звіряється, інтерполює (Lab 5).
// Параметри адреси для досліджень:
//   ?codec=json|binary  ?lag=100&jitter=30&drop=0.02  ?interp=100  ?predict=0  ?test=nondet
//   ?bot=1 — літає сам;  ?autojoin=r-classic&name=Ira — одразу в кімнату (для duo.html)

let paused = false
// Нетграф — інструмент розробника: у звичайній грі схований (N — показати),
// а відкритий одразу лише при досліді з мережею (?lag=…) або з ?netgraph=1
let showNet = params.has('lag') || params.has('netgraph')
gameUi.classList.toggle('hide-net', !showNet)
let detachNet = () => {}

function netOptions() {
  const num = (k, d) => (params.has(k) ? Number(params.get(k)) : d)
  return {
    codec: params.get('codec') ?? 'binary',
    lag: num('lag', 0),
    jitter: num('jitter', 0),
    drop: num('drop', 0),
    interpMs: num('interp', 100),
    predict: params.get('predict') !== '0',
  }
}

function startGame(room, name) {
  const arena = assets.json.arenas[room.arena] ?? Object.values(assets.json.arenas)[0]
  const bot = params.get('bot') === '1'
  let unmountRoom
  if (room.offline) {
    game = new OfflineGame({ arena, bot })
    const note = Object.assign(document.createElement('div'), {
      className: 'net-status closed',
      textContent: '● офлайн: одиночна гра (мультиплеєр працює з npm run dev)',
    })
    gameUi.replaceChildren(note)
    unmountRoom = () => gameUi.replaceChildren()
  } else {
    game = new NetGame({ room: { ...room, arenaConfig: arena }, name, net: netOptions(), bot })
    unmountRoom = mountRoomView(gameUi, game.conn, { room })
    detachNet = mountNetControls(gameUi, game)
  }
  game.name = name
  game.arena = arena

  // підписники подій гри: звук і HUD (офлайн — сам світ, онлайн — події зі знімків сервера)
  const detachAudio = audio.attach(game.events)
  const detachHud = hud.attach(game.events)
  game.detach = () => {
    detachAudio()
    detachHud()
    unmountRoom()
    detachNet()
    detachNet = () => {}
    game.close()
  }
  paused = false
  loop.start()
  if (DEV) window.game = { game, loop, lobby, assets, audio }
}

function stopGame() {
  if (!game) return
  loop.stop()
  game.detach()
  game = null
}

function simulate() {
  if (input.justPressed('Escape')) {
    input.consume()
    showLobby()
    return
  }
  if (input.justPressed('KeyM')) audio.toggleMute()
  if (input.justPressed('KeyN')) {
    showNet = !showNet
    gameUi.classList.toggle('hide-net', !showNet)
  }
  // пауза — лише офлайн: сервер не зупиниш заради одного гравця
  if (input.justPressed('KeyP') && !game.online) paused = !paused
  if (!paused) game.step(keyboardCommand(input))
  input.consume()
}

function drawNames(ctx, scene) {
  ctx.font = '12px monospace'
  ctx.textAlign = 'center'
  for (const s of scene.ofKind('ship')) {
    if (!s.name || s.isWaitingRespawn) continue
    ctx.fillStyle = s.isMe ? '#93c5fd' : '#f3efe0'
    ctx.fillText(s.name, s.pos.x, s.pos.y - 26)
  }
}

function render(alpha) {
  if (!game) return
  const cam = computeCamera(window.innerWidth, window.innerHeight)
  const now = performance.now()
  const scene = game.view(alpha, now)

  drawArenaBackground(ctx, cam, game.arena.sky ?? '#000')
  ctx.save()
  cam.apply(ctx)
  drawStarfield(ctx, stars)
  // офлайн: сутності мають prevPos/pos — інтерполяція між кроками через alpha;
  // онлайн: NetGame уже порахував позиції на "зараз", тож alpha = 1
  drawWorld(ctx, scene, game.online ? 1 : paused ? 1 : alpha, now / 1000, assets)
  if (game.online) drawNames(ctx, scene)
  ctx.restore()
  drawArenaBorder(ctx, cam)

  hud.draw(ctx, {
    stats: loop.stats,
    world: game.hudWorld,
    player: game.me,
    paused,
    playerName: game.name,
    soundState: audio.state,
    toScreen: cam.toScreen,
  })
  if (game.online && showNet) drawNetgraph(ctx, game)
}

const loop = createLoop({ simulate, render })

// ?autojoin=<roomId>&name=<ім'я> — одразу зайти в кімнату, щойно лобі отримає список (duo.html)
if (params.has('autojoin')) {
  lobby.addEventListener('rooms', function once(e) {
    if (e.detail.offline) return
    lobby.removeEventListener('rooms', once)
    lobby.join(params.get('autojoin'), params.get('name') ?? 'Pilot')
  })
}

boot(flags)
