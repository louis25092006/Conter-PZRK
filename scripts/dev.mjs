// npm run dev — запускає ОДНОЧАСНО сервер (порт 3000) і клієнт Vite (порт 5173).
// Без зовнішніх пакетів: просто два дочірні процеси Node, вивід із префіксами.
// Ctrl+C зупиняє обидва (сервер встигає акуратно закрити сокети й дописати логи).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// vite не експортує bin/ через "exports", тому шукаємо файл сам (workspaces кладуть його в корінь)
const vite = [root + 'node_modules/vite/bin/vite.js', root + 'client/node_modules/vite/bin/vite.js'].find(
  existsSync,
)
if (!vite) throw new Error('vite not found — run npm install (or npm.cmd install)')

// Порти фіксовані: сервер 3000 (на нього дивиться проксі Vite), клієнт 5173.
// Чужу змінну PORT (її може виставити оточення/IDE) навмисно не передаємо, інакше сервер
// сів би не на той порт і проксі /api, /ws нікуди б не вели.
const { PORT: _ignored, ...baseEnv } = process.env // eslint-disable-line no-unused-vars
const serverEnv = { ...baseEnv, PORT: process.env.SERVER_PORT ?? '3000' }

const CYAN = '\x1b[36m'
const MAGENTA = '\x1b[35m'
const RESET = '\x1b[0m'

const procs = [
  {
    name: 'server',
    args: ['--watch', '--env-file-if-exists=.env', 'src/index.js'],
    cwd: root + 'server',
    color: CYAN,
    env: serverEnv,
  },
  {
    name: 'client',
    args: [vite, '--port', '5173', '--strictPort'],
    cwd: root + 'client',
    color: MAGENTA,
    env: baseEnv,
  },
].map(({ name, args, cwd, color, env }) => {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const prefix = `${color}[${name}]${RESET} `
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) if (line) process.stdout.write(prefix + line + '\n')
    })
  }
  child.on('exit', (code) => console.log(`${prefix}exited with code ${code}`))
  return child
})

function stop() {
  for (const p of procs) p.kill('SIGINT')
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
