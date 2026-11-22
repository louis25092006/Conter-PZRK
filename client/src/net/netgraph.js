// Нетграф — інструмент для всієї Lab 5: без нього мережевий код "здається" робочим.
// Canvas-панель з цифрами й двома графіками (поправка звірки і RTT) + DOM-повзунки
// для імітатора мережі на сервері (затримка, джитер, втрати) і затримки інтерполяції.

const W = 290
const H = 196

function spark(ctx, x, y, w, h, values, max, color, label) {
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'
  ctx.strokeRect(x + 0.5, y + 0.5, w, h)
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.font = '10px monospace'
  ctx.fillText(label, x + 4, y + 11)
  if (values.length < 2) return
  ctx.beginPath()
  values.forEach((v, i) => {
    const px = x + (i / (values.length - 1)) * w
    const py = y + h - Math.min(1, v / max) * (h - 2) - 1
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  })
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.stroke()
}

export function drawNetgraph(ctx, game) {
  const s = game.stats
  const x = ctx.canvas.clientWidth - W - 10
  const y = ctx.canvas.clientHeight - H - 34
  ctx.save()
  ctx.fillStyle = 'rgba(8, 10, 16, 0.78)'
  ctx.fillRect(x, y, W, H)
  ctx.strokeStyle = 'rgba(245, 184, 61, 0.35)'
  ctx.strokeRect(x + 0.5, y + 0.5, W - 1, H - 1)

  ctx.font = '11px monospace'
  ctx.textAlign = 'left'
  const kb = (b) => (b / 1024).toFixed(1)
  const net = game.netConfig ?? {}
  const lines = [
    [
      `NETGRAPH  ${game.opts.codec.toUpperCase()}  ${game.opts.predict ? 'prediction ON' : 'prediction OFF'}`,
      '#f5b83d',
    ],
    [
      `RTT ${s.rtt.toFixed(0)} ms   snapshot age ${s.snapshotAge.toFixed(0)} ms (Δ ${s.snapshotInterval.toFixed(0)})`,
    ],
    [`down ${kb(s.bytesInPerSec)} KB/s   up ${kb(s.bytesOutPerSec)} KB/s   snap ${s.lastSnapshotBytes} B`],
    [`pending inputs ${s.pending}   ack ${game.ack}   seq ${game.seq}`],
    [
      `correction ${s.correction.toFixed(2)} px   max(2s) ${s.correctionMax.toFixed(1)} px`,
      s.correctionMax > 5 ? '#fca5a5' : '#9be8b8',
    ],
    [
      `interp ${game.opts.interpMs} ms   sim lag ${net.lag ?? 0}±${net.jitter ?? 0} ms  drop ${((net.drop ?? 0) * 100).toFixed(0)}%`,
    ],
  ]
  lines.forEach(([text, color], i) => {
    ctx.fillStyle = color ?? '#d1d5db'
    ctx.fillText(text, x + 8, y + 16 + i * 15)
  })
  spark(
    ctx,
    x + 8,
    y + 108,
    W - 16,
    38,
    s.corrections,
    Math.max(10, s.correctionMax),
    '#fca5a5',
    'correction px',
  )
  spark(ctx, x + 8, y + 150, W - 16, 38, s.rtts, Math.max(100, ...s.rtts), '#93c5fd', 'RTT ms')
  ctx.restore()
}

// DOM-панель керування (поруч із нетграфом). N — сховати/показати все.
export function mountNetControls(root, game) {
  const panel = document.createElement('div')
  panel.className = 'net-controls'
  const net = { lag: 0, jitter: 0, drop: 0, ...(game.netConfig ?? {}) }

  function slider(label, key, min, max, step, value, format, onChange) {
    const wrap = document.createElement('label')
    const text = document.createElement('span')
    const input = Object.assign(document.createElement('input'), { type: 'range', min, max, step, value })
    input.addEventListener('change', () => input.blur()) // повернути клавіатуру грі
    const show = () => (text.textContent = `${label} ${format(Number(input.value))}`)
    input.addEventListener('input', () => {
      show()
      onChange(Number(input.value))
    })
    show()
    wrap.append(text, input)
    return wrap
  }

  const send = () => game.setNetSim({ lag: net.lag, jitter: net.jitter, drop: net.drop })
  panel.append(
    slider(
      'lag',
      'lag',
      0,
      400,
      10,
      net.lag,
      (v) => `${v} ms`,
      (v) => ((net.lag = v), send()),
    ),
    slider(
      'jitter',
      'jitter',
      0,
      100,
      5,
      net.jitter,
      (v) => `${v} ms`,
      (v) => ((net.jitter = v), send()),
    ),
    slider(
      'drop',
      'drop',
      0,
      0.2,
      0.01,
      net.drop,
      (v) => `${Math.round(v * 100)}%`,
      (v) => ((net.drop = v), send()),
    ),
    slider(
      'interp',
      'interp',
      0,
      300,
      10,
      game.opts.interpMs,
      (v) => `${v} ms`,
      (v) => (game.opts.interpMs = v),
    ),
  )
  const predict = document.createElement('label')
  const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: game.opts.predict })
  box.addEventListener('change', () => (game.opts.predict = box.checked))
  predict.append(box, document.createTextNode(' prediction'))
  panel.append(predict)
  root.append(panel)

  // повзунки показують фактичні налаштування сервера, коли вони прийдуть
  game.conn.addEventListener('welcome', (e) => {
    const n = e.detail.net
    const inputs = panel.querySelectorAll('input[type=range]')
    ;[n.lag, n.jitter, n.drop].forEach((v, i) => {
      inputs[i].value = v
      inputs[i].dispatchEvent(new Event('input'))
    })
    Object.assign(net, n)
  })
  return () => panel.remove()
}
