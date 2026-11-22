// DOM поверх гри: хто в кімнаті, чат і стан з'єднання.
// Enter — відкрити поле чату, Enter ще раз — надіслати, Esc — закрити поле.
// Слухає події Connection ('roster', 'chat', 'system', 'status'), сам нічого не знає про сервер.

const MAX_LINES = 8
const LINE_TTL_MS = 12000

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props)
  for (const child of children) node.append(child)
  return node
}

export function mountRoomView(root, conn, { room }) {
  const status = el('div', { className: 'net-status', textContent: '● підключення…' })
  const rosterList = el('ul')
  const roster = el('div', { className: 'roster' }, [el('h3', { textContent: room.name }), rosterList])
  const log = el('div', { className: 'chat-log' })
  const input = el('input', { className: 'chat-input', maxLength: 200, placeholder: 'Повідомлення… (Enter)' })
  const chat = el('div', { className: 'chat' }, [log, input])
  root.replaceChildren(status, roster, chat)
  let me = null

  function addLine(parts, className = '') {
    const line = el('div', { className: `line ${className}` }, parts)
    log.append(line)
    while (log.children.length > MAX_LINES) log.firstChild.remove()
    setTimeout(() => line.classList.add('old'), LINE_TTL_MS) // старі рядки тьмяніють
  }

  const handlers = {
    welcome: (e) => {
      me = e.detail.you
      addLine([el('span', { textContent: `Ви в кімнаті «${e.detail.room.name}» як ${me.name}` })], 'system')
    },
    roster: (e) => {
      rosterList.replaceChildren(
        ...e.detail.players.map((p) =>
          el('li', {
            textContent: p.name + (p.id === me?.id ? ' (ви)' : ''),
            className: p.id === me?.id ? 'me' : '',
          }),
        ),
      )
    },
    chat: (e) => {
      const { from, text } = e.detail
      addLine(
        [el('b', { textContent: `${from.name}: ` }), el('span', { textContent: text })], // textContent — без XSS
        from.id === me?.id ? 'mine' : '',
      )
    },
    system: (e) => addLine([el('span', { textContent: e.detail.text })], 'system'),
    status: (e) => {
      const { state, attempt, delay, code, reason } = e.detail
      const text = {
        connecting: '● підключення…',
        open: '● online',
        reconnecting: `● зв'язок втрачено, спроба ${attempt} через ${Math.round((delay ?? 0) / 1000)} с`,
        closed: `● offline${code && code !== 1000 ? ` (${code}${reason ? ': ' + reason : ''})` : ''}`,
      }[state]
      status.textContent = text ?? state
      status.className = `net-status ${state}`
      if (state === 'closed' && code >= 4000) {
        addLine([el('span', { textContent: `Сервер закрив з'єднання: ${reason || code}` })], 'system error')
      }
    },
  }
  for (const [type, fn] of Object.entries(handlers)) conn.addEventListener(type, fn)

  // Enter у грі відкриває поле чату
  function onKey(e) {
    if (e.code === 'Enter' && e.target !== input && document.activeElement !== input) {
      e.preventDefault()
      input.classList.add('open')
      input.focus()
    }
  }
  input.addEventListener('keydown', (e) => {
    // Enter/Esc з поля не повинні "спливти" до window: інакше той самий Enter
    // одразу відкрив би поле знову, а Esc вийшов би з гри
    if (e.code === 'Enter' || e.code === 'Escape') e.stopPropagation()
    if (e.code === 'Enter') {
      const text = input.value.trim()
      if (text) conn.send({ type: 'chat', text })
      input.value = ''
      input.blur()
      input.classList.remove('open')
    } else if (e.code === 'Escape') {
      input.value = ''
      input.blur()
      input.classList.remove('open')
    }
  })
  window.addEventListener('keydown', onKey)

  return () => {
    for (const [type, fn] of Object.entries(handlers)) conn.removeEventListener(type, fn)
    window.removeEventListener('keydown', onKey)
    root.replaceChildren()
  }
}
