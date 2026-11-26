import type { Input } from './input.ts'

// Lab 8: сенсорний пульт для телефона (PWA). Кнопки натискають ті самі «клавіші», що й клавіатура,
// тож симуляція, мережа й бот нічого про дотики не знають. Показується лише на сенсорних екранах.
const BUTTONS: readonly { code: string; label: string; area: 'left' | 'right' | 'top'; title: string }[] = [
  { code: 'ArrowLeft', label: '◀', area: 'left', title: 'Ліворуч' },
  { code: 'ArrowRight', label: '▶', area: 'left', title: 'Праворуч' },
  { code: 'ArrowUp', label: '▲', area: 'right', title: 'Газ' },
  { code: 'Space', label: '●', area: 'right', title: 'Вогонь' },
  { code: 'Escape', label: '✕', area: 'top', title: 'У лобі' },
]

export function isTouchDevice(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}

export function mountTouchControls(input: Input): () => void {
  const root = document.createElement('div')
  root.className = 'touch-controls'
  const areas: readonly ('left' | 'right' | 'top')[] = ['left', 'right', 'top']
  for (const area of areas) {
    const group = document.createElement('div')
    group.className = `touch-${area}`
    for (const b of BUTTONS.filter((x) => x.area === area)) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = b.label
      btn.title = b.title
      btn.setAttribute('aria-label', b.title)
      const press = (e: PointerEvent): void => {
        e.preventDefault()
        input.press(b.code) // спершу — натискання; захоплення вказівника лише «на додачу»
        btn.classList.add('down')
        try {
          btn.setPointerCapture(e.pointerId) // палець з'їхав з кнопки — вона однаково отримає pointerup
        } catch {
          // вказівник уже неактивний (наприклад, штучна подія) — нічого страшного
        }
      }
      const release = (): void => {
        btn.classList.remove('down')
        input.release(b.code)
      }
      btn.addEventListener('pointerdown', press)
      btn.addEventListener('pointerup', release)
      btn.addEventListener('pointercancel', release)
      btn.addEventListener('lostpointercapture', release)
      group.append(btn)
    }
    root.append(group)
  }
  document.body.append(root)
  return () => root.remove()
}
