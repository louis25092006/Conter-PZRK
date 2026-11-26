import { createLoop } from './loop.ts'
import { createInput } from './input.ts'
import { createAudio } from './audio.ts'
import { createHud } from './hud.ts'
import { setupCanvas, requireElement } from './render/canvas.ts'
import { createStarfield, drawStarfield, prerenderStarfield, drawWorld, type Scene } from './render/draw.ts'
import { drawLoadingScreen, type LoadingScreenState } from './render/loading.ts'
import { createLobbyBackground } from './render/lobby-bg.ts'
import {
  fetchJson,
  withRetry,
  loadAll,
  loadAllSequential,
  isAbort,
  HttpError,
  AssetFormatError,
  ManifestSchema,
  type LoadedAssets,
  type Manifest,
} from './assets/loader.ts'
import { readTestFlags, applyTestFlags, type TestFlags } from './assets/test-flags.ts'
import { Lobby, type LobbyRoom } from './lobby/lobby.ts'
import { mountLobbyView } from './lobby/lobby-view.ts'
import { mountRoomView } from './net/room-view.ts'
import { NetGame, type NetOptions } from './net/net-game.ts'
import { drawNetgraph, mountNetControls } from './net/netgraph.ts'
import { OfflineGame } from './game/offline-game.ts'
import { keyboardCommand } from './game/commands.ts'
import { computeCamera, drawArenaBackground, drawArenaBorder } from './game/camera.ts'
import { ARENA_SIZE } from '../../shared/src/sim/arena.ts'
import { debug as simDebug } from '../../shared/src/sim/ship-physics.ts'
import { perfStart, perfEnd, perfSummary, perfReset } from './perf.ts'
import { isTouchDevice, mountTouchControls } from './touch.ts'
import { ArenasSchema, type ArenaConfig, type Arenas } from '../../shared/src/arena-config.ts'

// Сценарій гри:  завантаження → лобі → гра → (Esc) → лобі → …

const canvas = requireElement('game', HTMLCanvasElement)
const ctx = setupCanvas(canvas)
const ui = requireElement('ui', HTMLElement)
const gameUi = requireElement('game-ui', HTMLElement)
const input = createInput(window)
const audio = createAudio()
const hud = createHud()
const flags = readTestFlags(location.search)
const params = new URLSearchParams(location.search)
// Lab 5, дослід M2: ?test=nondet — навмисно зламати детермінізм передбачення (лише на клієнті)
if (flags.has('nondet')) simDebug.breakDeterminism = true
// import.meta.env існує лише під Vite; у Live Server / GitHub Pages його немає
const DEV = import.meta.env?.DEV ?? false

// для відладки з консолі (лише в dev): window.game
declare global {
  interface Window {
    game?: unknown
  }
}

// браузер дозволяє звук лише після жесту користувача
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => audio.unlock())

// зорі — у координатах арени (вона тепер фіксована), камера масштабує їх разом зі світом
const stars = createStarfield(ARENA_SIZE.width, ARENA_SIZE.height, 260)
const starLayer = prerenderStarfield(stars, ARENA_SIZE.width, ARENA_SIZE.height)

// що відомо після завантаження: ассети + перевірений (zod) конфіг арен
interface Loaded {
  readonly assets: LoadedAssets
  readonly arenas: Arenas
}
let loaded: Loaded | null = null

// поточна гра: OfflineGame або NetGame (у них однаковий інтерфейс) + те, що до неї прив'язано
interface Session {
  readonly game: OfflineGame | NetGame
  readonly name: string
  readonly arena: ArenaConfig
  readonly detach: () => void
}
let session: Session | null = null

function button(text: string, onClick: () => void, className = ''): HTMLButtonElement {
  const b = Object.assign(document.createElement('button'), { textContent: text, className })
  b.addEventListener('click', onClick)
  return b
}

// ---------- 1. Завантаження ----------

async function boot(activeFlags: TestFlags): Promise<void> {
  const controller = new AbortController()
  const signal = controller.signal
  const screen: LoadingScreenState = {
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
    const { url: manifestUrl, manifest: raw } = await findManifest(signal)
    // адреси в маніфесті відносні (sprites/ships.svg) — рахуємо їх від папки, де знайшли маніфест
    const flagged = applyTestFlags(raw, activeFlags)
    const manifest: Manifest = {
      ...flagged,
      items: flagged.items.map((item) => ({ ...item, url: new URL(item.url, manifestUrl).href })),
    }
    screen.phase = 'loading'
    screen.total = manifest.items.length

    const load = activeFlags.has('sequential') ? loadAllSequential : loadAll
    const t0 = performance.now()
    const assets = await load(manifest, {
      audioCtx: audio.ctx ?? undefined,
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
    // JSON з мережі — unknown, доки схема не скаже інакше (зіпсований файл → екран помилки)
    const parsed = ArenasSchema.safeParse(assets.json.arenas)
    if (!parsed.success)
      throw new AssetFormatError(`arenas.json: ${parsed.error.message}`, 'arenas.json', parsed.error)
    loaded = { assets, arenas: parsed.data }

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
          void boot(new Set())
        },
        'primary',
      ),
    )
  }
}

// Де лежать ассети, залежить від того, ЯК запущено гру:
//   Vite (npm run dev), наш Node-сервер, збірка site/ → assets/manifest.json (public/ стає коренем сайту)
//   Live Server у VS Code на сирцях                    → ./public/assets/manifest.json
// Пробуємо по черзі; 404 означає "не тут", інші помилки — справжні.
async function findManifest(signal: AbortSignal): Promise<{ url: URL; manifest: Manifest }> {
  const candidates = ['assets/manifest.json', 'public/assets/manifest.json'].map(
    (p) => new URL(p, document.baseURI),
  )
  let lastError: unknown = new Error('manifest.json not found')
  for (const url of candidates) {
    try {
      const data = await withRetry(() => fetchJson(url.href, { signal, timeoutMs: 4000 }), { signal })
      const manifest = ManifestSchema.safeParse(data)
      if (!manifest.success)
        throw new AssetFormatError(`manifest: ${manifest.error.message}`, url.href, manifest.error)
      return { url, manifest: manifest.data }
    } catch (error) {
      const notHere = error instanceof HttpError && error.status === 404
      // статичний сервер на невідому адресу інколи віддає HTML-сторінку — теж "не тут"
      const htmlInsteadOfJson = error instanceof AssetFormatError
      if (!(notHere || htmlInsteadOfJson)) throw error
      lastError = error
    }
  }
  throw lastError
}

// ---------- 2. Лобі ----------

const lobby = new Lobby({
  url: flags.has('lobbyslow') ? '/api/rooms?delay=5000' : '/api/rooms',
  intervalMs: 4000,
  timeoutMs: 3000,
})
let unmountLobby: (() => void) | null = null
const lobbyBg = createLobbyBackground(ctx) // живе небо з літаками за панеллю лобі

function showLobby(): void {
  if (!loaded) return
  stopGame()
  ui.className = 'overlay'
  lobby.offlineRooms = Object.entries(loaded.arenas).map(([id, arena]): LobbyRoom => ({
    id: `offline-${id}`,
    name: arena.name,
    arena: id,
    players: 0,
    maxPlayers: 1,
    offline: true,
  }))
  unmountLobby = mountLobbyView(ui, lobby, { arenas: loaded.arenas })
  lobby.open()
  lobbyBg.start()
  if (DEV) window.game = { lobby, loaded, audio }
}

lobby.events.on('close', () => {
  lobbyBg.stop()
  unmountLobby?.()
  unmountLobby = null
  ui.className = ''
})

lobby.events.on('join', ({ room, name }) => {
  audio.unlock() // клік "Join" — теж жест користувача
  startGame(room, name)
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

function netOptions(): NetOptions {
  const num = (k: string, d: number): number => {
    const v = params.get(k)
    return v === null ? d : Number(v)
  }
  return {
    codec: params.get('codec') === 'json' ? 'json' : 'binary',
    lag: num('lag', 0),
    jitter: num('jitter', 0),
    drop: num('drop', 0),
    interpMs: num('interp', 100),
    predict: params.get('predict') !== '0',
  }
}

function firstArena(arenas: Arenas): ArenaConfig {
  const first = Object.values(arenas)[0]
  if (!first) throw new Error('arenas.json is empty')
  return first
}

function startGame(room: LobbyRoom, name: string): void {
  if (!loaded) return
  const arena = loaded.arenas[room.arena] ?? firstArena(loaded.arenas)
  const bot = params.get('bot') === '1'
  let game: OfflineGame | NetGame
  let unmountRoom: () => void
  let detachNet = (): void => {}
  if (room.offline) {
    game = new OfflineGame({ arena, bot })
    const note = Object.assign(document.createElement('div'), {
      className: 'net-status closed',
      textContent: '● офлайн: одиночна гра (мультиплеєр працює з npm run dev)',
    })
    gameUi.replaceChildren(note)
    unmountRoom = () => gameUi.replaceChildren()
  } else {
    const net = new NetGame({ room: { ...room, arenaConfig: arena }, name, net: netOptions(), bot })
    unmountRoom = mountRoomView(gameUi, net.conn, { room })
    const offControls = mountNetControls(gameUi, net)
    // Lab 8: сервер вимикається (новий деплой) або зв'язок остаточно втрачено → назад у лобі
    // з поясненням; лобі саме опитує сервер з backoff і покаже кімнати, щойно він повернеться
    const backToLobby = (text: string): void =>
      queueMicrotask(() => {
        if (session?.game !== net) return // уже вийшли з цієї гри
        showLobby()
        lobby.notify(text)
      })
    const offShutdown = net.conn.events.on('shutdown', () =>
      backToLobby('Сервер перезапускається (оновлення) — кімнати з’являться, щойно він повернеться'),
    )
    // перепідключились, а bootId інший → сервер перезапустився, матч на ньому скинуто → у лобі
    let bootId: string | null = null
    const offWelcome = net.conn.events.on('welcome', (m) => {
      if (bootId !== null && m.bootId !== bootId)
        backToLobby('Сервер перезапустився — попередній матч скинуто. Оберіть кімнату, щоб грати далі')
      bootId = m.bootId
    })
    const offStatus = net.conn.events.on('status', ({ state, code }) => {
      if (state === 'closed' && code !== 1000)
        backToLobby(`Зв'язок із сервером втрачено${code ? ` (код ${code})` : ''} — пробую знову…`)
    })
    detachNet = () => {
      offControls()
      offShutdown()
      offWelcome()
      offStatus()
    }
    game = net
  }

  // підписники подій гри: звук і HUD (офлайн — сам світ, онлайн — події зі знімків сервера)
  const detachAudio = audio.attach(game.events)
  const detachHud = hud.attach(game.events)
  const detachTouch = isTouchDevice() ? mountTouchControls(input) : (): void => {} // Lab 8: телефон
  const current = game
  session = {
    game,
    name,
    arena,
    detach: () => {
      detachAudio()
      detachHud()
      detachTouch()
      unmountRoom()
      detachNet()
      current.close()
    },
  }
  paused = false
  loop.start()
  if (DEV) window.game = { session, loop, lobby, loaded, audio, perf: perfSummary, perfReset }
}

function stopGame(): void {
  if (!session) return
  loop.stop()
  session.detach()
  session = null
}

function simulate(): void {
  if (!session) return
  const t0 = perfStart()
  simulateStep(session)
  perfEnd('simulate', t0)
}

function simulateStep(session: Session): void {
  const { game } = session
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

function drawNames(ctx: CanvasRenderingContext2D, scene: Scene): void {
  ctx.font = '12px monospace'
  ctx.textAlign = 'center'
  for (const s of scene.ship) {
    if (!s.name || s.isWaitingRespawn) continue
    ctx.fillStyle = s.isMe ? '#93c5fd' : '#f3efe0'
    ctx.fillText(s.name, s.pos.x, s.pos.y - 26)
  }
}

function render(alpha: number): void {
  const t0 = perfStart()
  renderFrame(alpha)
  perfEnd('render', t0)
}

function renderFrame(alpha: number): void {
  if (!session || !loaded) return
  const { game, arena, name } = session
  const cam = computeCamera(window.innerWidth, window.innerHeight)
  const now = performance.now()
  const scene = game.view(alpha, now)

  drawArenaBackground(ctx, cam, arena.sky)
  ctx.save()
  cam.apply(ctx)
  if (starLayer) ctx.drawImage(starLayer, 0, 0)
  else drawStarfield(ctx, stars)
  // офлайн: сутності мають prevPos/pos — інтерполяція між кроками через alpha;
  // онлайн: NetGame уже порахував позиції на "зараз", тож alpha = 1
  drawWorld(ctx, scene, game.online || paused ? 1 : alpha, now / 1000, loaded.assets)
  if (game.online) drawNames(ctx, scene)
  ctx.restore()
  drawArenaBorder(ctx, cam)

  hud.draw(ctx, {
    stats: loop.stats,
    world: game.hudWorld,
    player: game.me,
    paused,
    playerName: name,
    soundState: audio.state,
    toScreen: (x, y) => cam.toScreen(x, y),
  })
  // game.online — дискримінант: тут TypeScript уже знає, що game — NetGame
  if (game.online && showNet) drawNetgraph(ctx, game)
}

const loop = createLoop({ simulate, render })

// ?autojoin=<roomId>&name=<ім'я> — одразу зайти в кімнату, щойно лобі отримає список (duo.html)
const autojoin = params.get('autojoin')
if (autojoin !== null) {
  const off = lobby.events.on('rooms', ({ offline }) => {
    if (offline) return
    off()
    lobby.join(autojoin, params.get('name') ?? 'Pilot')
  })
}

void boot(flags)

// Lab 8: PWA — service worker кешує гру, щоб її можна було встановити й швидко відкривати.
// У dev (Vite) не реєструємо: кеш заважав би гарячому перезавантаженню.
if (!DEV && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .catch((e: unknown) => console.warn('[pwa] SW registration failed', e))
  })
}
