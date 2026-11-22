// DOM-відображення лобі. Знає про Lobby тільки його події і методи (join, refresh, createRoom).
// Назви кімнат і імена приходять ззовні — тому для них лише textContent, ніякого innerHTML.
// innerHTML використовується тільки для наших власних статичних SVG-іконок нижче.

import { el } from '../dom.ts'
import { isTimeout } from '../assets/loader.ts'
import { errorMessage } from '../../../shared/src/types.ts'
import type { Arenas } from '../../../shared/src/arena-config.ts'
import type { Lobby, LobbyEvents, LobbyRoom } from './lobby.ts'

// ---------- іконки (статичні SVG, без даних користувача) ----------

const PLANE =
  '<path d="M21 12 14 9.6V5.5c0-1-.9-2-2-2s-2 1-2 2v4.1L3 12v2l7-1.6v4.2L8 18v1.5l4-.9 4 .9V18l-2-1.4v-4.2l7 1.6z"/>'
type IconName = 'plane' | 'classic' | 'training' | 'dogfight' | 'refresh' | 'user' | 'plus' | 'emblem'
const ICONS: Readonly<Record<IconName, string>> = {
  plane: `<svg viewBox="0 0 24 24" fill="currentColor">${PLANE}</svg>`,
  classic: `<svg viewBox="0 0 24 24" fill="currentColor">${PLANE}</svg>`,
  training: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>`,
  dogfight: `<svg viewBox="0 0 24 24" fill="currentColor"><g transform="rotate(-35 12 12) translate(-3 0) scale(.75)">${PLANE}</g><g transform="rotate(145 12 12) translate(-3 0) scale(.75)">${PLANE}</g></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>`,
  user: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7z"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  // емблема: мішень ППО з силуетом літака
  emblem: `<svg viewBox="0 0 64 64">
    <circle cx="32" cy="32" r="30" fill="#1b1a12" stroke="#f5b83d" stroke-width="3"/>
    <circle cx="32" cy="32" r="21" fill="none" stroke="#f5b83d" stroke-width="1.5" stroke-dasharray="4 3"/>
    <path d="M32 2v12M32 50v12M2 32h12M50 32h12" stroke="#f5b83d" stroke-width="2.5"/>
    <g transform="translate(32 32) rotate(-45) scale(1.15) translate(-12 -12)" fill="#f3efe0">${PLANE}</g>
  </svg>`,
}

function icon(name: IconName, className = 'icon'): HTMLSpanElement {
  const span = el('span', { className })
  span.innerHTML = ICONS[name]
  return span
}

const ARENA_LOOK: Readonly<Record<string, { icon: IconName; tag: string }>> = {
  classic: { icon: 'classic', tag: 'Класика' },
  training: { icon: 'training', tag: 'Тренування' },
  dogfight: { icon: 'dogfight', tag: 'Повітряний бій' },
}

const DEFAULT_LOOK = { icon: 'classic', tag: 'Класика' } satisfies { icon: IconName; tag: string }

// ---------- лобі ----------

export function mountLobbyView(root: HTMLElement, lobby: Lobby, { arenas }: { arenas: Arenas }): () => void {
  let selected: string | null = null

  const nameInput = el('input', {
    className: 'name',
    maxLength: 16,
    placeholder: 'Наприклад, Falcon',
    value: localStorage.getItem('pilotName') ?? '',
    autocomplete: 'off',
    spellcheck: false,
  })
  const list = el('ul', { className: 'rooms' })
  const statusText = el('span', { textContent: 'Шукаю сервери…' })
  const status = el('p', { className: 'status' }, [el('i', { className: 'radar' }), statusText])
  const joinBtn = el('button', { className: 'primary join', disabled: true }, [
    el('span', { textContent: 'До бою' }),
    icon('plane'),
  ])
  const refreshBtn = el('button', { className: 'ghost icon-btn', title: 'Оновити список' }, [icon('refresh')])

  // створити свою кімнату (POST /api/rooms) — сховано під кнопкою, щоб не захаращувати
  const newName = el('input', { className: 'new-room', maxLength: 32, placeholder: 'Назва кімнати' })
  const newArena = el(
    'select',
    {},
    Object.entries(arenas).map(([id, a]) => el('option', { value: id, textContent: a.name })),
  )
  const createBtn = el('button', { className: 'secondary', textContent: 'Створити' })
  const createRow = el('div', { className: 'create-row' }, [newName, newArena, createBtn])
  const toggleCreate = el('button', { className: 'ghost add' }, [
    icon('plus'),
    el('span', { textContent: 'Своя кімната' }),
  ])
  toggleCreate.addEventListener('click', () => {
    createRow.classList.toggle('open')
    if (createRow.classList.contains('open')) newName.focus()
  })

  const panel = el('div', { className: 'panel lobby' }, [
    el('header', { className: 'lobby-head' }, [
      icon('emblem', 'emblem'),
      el('div', {}, [
        el('h1', { textContent: 'Conter-PZRK' }),
        el('p', { className: 'tagline', textContent: 'Протиповітряна оборона · онлайн-арена' }),
      ]),
    ]),
    el('label', { className: 'field' }, [
      el('span', { className: 'field-label', textContent: 'Позивний пілота' }),
      el('span', { className: 'input-wrap' }, [icon('user'), nameInput]),
    ]),
    el('div', { className: 'section-head' }, [
      el('span', { className: 'field-label', textContent: 'Обери небо' }),
      el('span', { className: 'section-tools' }, [toggleCreate, refreshBtn]),
    ]),
    createRow,
    list,
    status,
    joinBtn,
  ])
  root.replaceChildren(panel)

  function renderRooms(rooms: readonly LobbyRoom[]): void {
    list.replaceChildren(
      ...rooms.map((room): HTMLLIElement => {
        const full = room.players >= room.maxPlayers
        const look = ARENA_LOOK[room.arena] ?? DEFAULT_LOOK
        const arenaName = arenas[room.arena]?.name ?? room.arena
        const fill = room.offline ? 0 : Math.min(1, room.players / room.maxPlayers)
        const li = el(
          'li',
          {
            className: ['room', `arena-${room.arena}`, full && 'full', room.id === selected && 'selected']
              .filter(Boolean)
              .join(' '),
            tabIndex: full ? -1 : 0,
          },
          [
            icon(look.icon, 'room-icon'),
            el('span', { className: 'room-info' }, [
              el('span', { className: 'room-name', textContent: room.name }),
              el('span', { className: 'room-tag', textContent: `${look.tag} · ${arenaName}` }),
            ]),
            el('span', { className: 'room-players' }, [
              el('span', {
                className: 'count',
                textContent: room.offline ? 'соло' : full ? 'повна' : `${room.players}/${room.maxPlayers}`,
              }),
              el('span', { className: 'bar' }, [el('i', { style: `width:${fill * 100}%` })]),
            ]),
          ],
        )
        if (!full) {
          li.addEventListener('click', () => select(room.id, rooms))
          li.addEventListener('dblclick', () => doJoin())
          li.addEventListener('keydown', (e) => e.key === 'Enter' && (select(room.id, rooms), doJoin()))
        }
        return li
      }),
    )
  }

  function select(id: string, rooms: readonly LobbyRoom[]): void {
    selected = id
    joinBtn.disabled = false
    renderRooms(rooms)
  }

  function doJoin() {
    if (!selected) return
    localStorage.setItem('pilotName', nameInput.value.trim())
    lobby.join(selected, nameInput.value)
  }

  function setStatus(text: string, kind = ''): void {
    status.className = `status ${kind}`
    statusText.textContent = text
  }

  const onRooms = (e: LobbyEvents['rooms']): void => {
    const { rooms, at } = e
    if (selected && !rooms.some((r) => r.id === selected && r.players < r.maxPlayers)) {
      selected = null
      joinBtn.disabled = true
    }
    renderRooms(rooms)
    if (e.offline) {
      setStatus('Сервер недоступний — офлайн: одиночна гра без чату (повна версія: npm run dev)', 'offline')
      return
    }
    const online = rooms.reduce((n, r) => n + r.players, 0)
    setStatus(`Сервер на зв'язку · пілотів у небі: ${online} · оновлено ${at.toLocaleTimeString()}`, 'online')
  }
  const onError = ({ error }: LobbyEvents['error']): void => {
    setStatus(
      isTimeout(error)
        ? `Сервер не відповів за ${lobby.timeoutMs / 1000} с — пробую ще раз…`
        : `Помилка: ${errorMessage(error)}`,
      'error',
    )
  }

  async function doCreate(): Promise<void> {
    const name = newName.value.trim()
    if (!name) return newName.focus()
    createBtn.disabled = true
    const room = await lobby.createRoom(name, newArena.value)
    createBtn.disabled = false
    if (room) {
      newName.value = ''
      createRow.classList.remove('open')
      select(room.id, lobby.rooms)
    }
  }
  createBtn.addEventListener('click', () => void doCreate())
  newName.addEventListener('keydown', (e) => e.key === 'Enter' && void doCreate())

  const offRooms = lobby.events.on('rooms', onRooms)
  const offError = lobby.events.on('error', onError)
  joinBtn.addEventListener('click', doJoin)
  refreshBtn.addEventListener('click', () => void lobby.refresh())
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && doJoin())

  if (lobby.rooms.length) renderRooms(lobby.rooms)
  nameInput.focus()

  // прибрати за собою (коли лобі закривається)
  return () => {
    offRooms()
    offError()
    root.replaceChildren()
  }
}
