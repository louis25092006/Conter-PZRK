// Дослід M4: чому забутий слухач 'error' або необроблений reject валить ВЕСЬ сервер.
//   node scripts/crash-demo.js emitter-no-listener   ← падає
//   node scripts/crash-demo.js emitter-with-listener ← живе
//   node scripts/crash-demo.js rejection             ← падає (Node ≥ 15)
//   node scripts/crash-demo.js rejection-handled     ← живе
//
// Імітація: "сервер" з двома гравцями; у сокета другого гравця стається помилка мережі
// (як ECONNRESET, коли в нього пропав Wi-Fi). Перший гравець має продовжити грати.

import { EventEmitter } from 'node:events'

const mode = process.argv[2] ?? 'emitter-no-listener'
const log = (msg) => console.log(`${new Date().toISOString().slice(11, 23)} ${msg}`)

class FakeSocket extends EventEmitter {}
const alice = new FakeSocket()
const bob = new FakeSocket()

if (mode === 'emitter-with-listener') {
  // ВИПРАВЛЕННЯ: слухач 'error' на кожному сокеті (як у server/src/ws.js)
  for (const s of [alice, bob])
    s.on('error', (err) => log(`socket error handled: ${err.code} — closing this socket only`))
}

process.on('exit', (code) => log(`process exit, code ${code}`))

let tick = 0
const game = setInterval(() => {
  tick++
  log(`game tick ${tick}: alice is still playing`)
  if (tick === 2) {
    if (mode.startsWith('emitter')) {
      const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      log("bob's connection dropped → bob.emit('error')")
      bob.emit('error', err) // без слухача EventEmitter КИДАЄ цю помилку → процес падає
    } else {
      log('loading bob replay from a broken file…')
      const p = Promise.reject(new Error('ENOENT: replay file missing'))
      if (mode === 'rejection-handled') p.catch((err) => log(`handled: ${err.message}`))
    }
  }
  if (tick === 4) {
    clearInterval(game)
    log('server survived, alice finished the match')
  }
}, 100)
