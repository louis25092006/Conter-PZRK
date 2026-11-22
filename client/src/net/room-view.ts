import { el } from '../dom.ts'
import type { Connection, ConnectionState } from './connection.ts'
import type { PlayerInfo, RoomInfo } from '../../../shared/src/protocol.ts'

// DOM поверх гри: хто в кімнаті, чат і стан з'єднання.
// Enter — відкрити поле чату, Enter ще раз — надіслати, Esc — закрити поле.
// Слухає типізовані події Connection ('roster', 'chat', 'system', 'status').

const MAX_LINES = 8
const LINE_TTL_MS = 12000

export function mountRoomView(
  root: HTMLElement,
  conn: Connection,
  { room }: { room: Pick<RoomInfo, 'name'> },
): () => void {
  const status = el('div', { className: 'net-status', textContent: '● підключення…' })
  const rosterList = el('ul')
  const roster = el('div', { className: 'roster' }, [el('h3', { textContent: room.name }), rosterList])
  const log = el('div', { className: 'chat-log' })
  const input = el('input', { className: 'chat-input', maxLength: 200, placeholder: 'Повідомлення… (Enter)' })
  const chat = el('div', { className: 'chat' }, [log, input])
  root.replaceChildren(status, roster, chat)
  let me: PlayerInfo | null = null

  function addLine(parts: readonly Node[], className = ''): void {
    const line = el('div', { className: `line ${className}` }, parts)
    log.append(line)
    while (log.children.length > MAX_LINES) log.firstChild?.remove()
    setTimeout(() => line.classList.add('old'), LINE_TTL_MS) // старі рядки тьмяніють
  }

  const statusText: Readonly<Record<ConnectionState, (attempt: number, delay: number) => string>> = {
    idle: () => '● …',
    connecting: () => '● підключення…',
    open: () => '● online',
    reconnecting: (attempt, delay) =>
      `● зв'язок втрачено, спроба ${attempt} через ${Math.round(delay / 1000)} с`,
    closed: () => '● offline',
  }

  const offs = [
    conn.events.on('welcome', (m) => {
      me = m.you
      addLine([el('span', { textContent: `Ви в кімнаті «${m.room.name}» як ${m.you.name}` })], 'system')
    }),
    conn.events.on('roster', (m) => {
      rosterList.replaceChildren(
        ...m.players.map((p) =>
          el('li', {
            textContent: p.name + (p.id === me?.id ? ' (ви)' : ''),
            className: p.id === me?.id ? 'me' : '',
          }),
        ),
      )
    }),
    conn.events.on('chat', (m) => {
      // textContent — без XSS, навіть якщо в імені чи тексті є <script>
      addLine(
        [el('b', { textContent: `${m.from.name}: ` }), el('span', { textContent: m.text })],
        m.from.id === me?.id ? 'mine' : '',
      )
    }),
    conn.events.on('system', (m) => addLine([el('span', { textContent: m.text })], 'system')),
    conn.events.on('status', ({ state, attempt, delay, code, reason }) => {
      let text = statusText[state](attempt, delay ?? 0)
      if (state === 'closed' && code && code !== 1000) text += ` (${code}${reason ? ': ' + reason : ''})`
      status.textContent = text
      status.className = `net-status ${state}`
      if (state === 'closed' && code !== undefined && code >= 4000) {
        addLine([el('span', { textContent: `Сервер закрив з'єднання: ${reason || code}` })], 'system error')
      }
    }),
  ]

  // Enter у грі відкриває поле чату
  function onKey(e: KeyboardEvent): void {
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
    for (const off of offs) off()
    window.removeEventListener('keydown', onKey)
    root.replaceChildren()
  }
}
