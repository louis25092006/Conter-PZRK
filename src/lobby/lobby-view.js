// DOM-відображення лобі. Знає про Lobby тільки його події і два методи (join, close).
// Назви кімнат приходять із сервера — тому лише textContent, ніякого innerHTML.

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props)
  for (const child of children) node.append(child)
  return node
}

export function mountLobbyView(root, lobby, { arenas }) {
  let selected = null

  const nameInput = el('input', {
    className: 'name',
    maxLength: 16,
    placeholder: 'Pilot',
    value: localStorage.getItem('pilotName') ?? '',
  })
  const list = el('ul', { className: 'rooms' })
  const status = el('p', { className: 'status', textContent: 'Завантажую кімнати…' })
  const joinBtn = el('button', { className: 'primary', textContent: 'Join', disabled: true })
  const refreshBtn = el('button', { textContent: 'Оновити' })

  const panel = el('div', { className: 'panel lobby' }, [
    el('h1', { textContent: 'Conter-PZRK' }),
    el('label', { textContent: 'Ім’я пілота' }, [nameInput]),
    el('h2', { textContent: 'Кімнати' }),
    list,
    status,
    el('div', { className: 'row' }, [refreshBtn, joinBtn]),
  ])
  root.replaceChildren(panel)

  function renderRooms(rooms) {
    list.replaceChildren(
      ...rooms.map((room) => {
        const full = room.players >= room.maxPlayers
        const arena = arenas[room.arena]?.name ?? room.arena
        const li = el(
          'li',
          { className: [full && 'full', room.id === selected && 'selected'].filter(Boolean).join(' ') },
          [
            el('span', { className: 'room-name', textContent: room.name }),
            el('span', {
              className: 'room-meta',
              textContent: `${arena} · ${room.players}/${room.maxPlayers}`,
            }),
          ],
        )
        if (!full) li.addEventListener('click', () => select(room.id, rooms))
        li.addEventListener('dblclick', () => !full && doJoin())
        return li
      }),
    )
  }

  function select(id, rooms) {
    selected = id
    joinBtn.disabled = false
    renderRooms(rooms)
  }

  function doJoin() {
    if (!selected) return
    localStorage.setItem('pilotName', nameInput.value.trim())
    lobby.join(selected, nameInput.value)
  }

  const onRooms = (e) => {
    const { rooms, at } = e.detail
    if (selected && !rooms.some((r) => r.id === selected && r.players < r.maxPlayers)) {
      selected = null
      joinBtn.disabled = true
    }
    renderRooms(rooms)
    status.className = 'status'
    status.textContent = `Кімнат: ${rooms.length} · оновлено ${at.toLocaleTimeString()} · автооновлення кожні ${lobby.intervalMs / 1000} с`
  }
  const onError = (e) => {
    const { error } = e.detail
    status.className = 'status error'
    status.textContent =
      error.name === 'TimeoutError'
        ? `Сервер не відповів за ${lobby.timeoutMs / 1000} с — спробую ще раз автоматично`
        : `Помилка: ${error.message}`
  }

  lobby.addEventListener('rooms', onRooms)
  lobby.addEventListener('error', onError)
  joinBtn.addEventListener('click', doJoin)
  refreshBtn.addEventListener('click', () => lobby.refresh())
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && doJoin())

  if (lobby.rooms.length) renderRooms(lobby.rooms)
  nameInput.focus()

  // прибрати за собою (коли лобі закривається)
  return () => {
    lobby.removeEventListener('rooms', onRooms)
    lobby.removeEventListener('error', onError)
    root.replaceChildren()
  }
}
