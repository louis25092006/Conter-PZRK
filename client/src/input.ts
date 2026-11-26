// Клавіші, які браузер інакше використав би сам (прокрутка сторінки пробілом/стрілками)
const GAME_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

export interface Input {
  isDown(code: string): boolean
  justPressed(code: string): boolean
  consume(): void
  // Lab 8: «віртуальні клавіші» для сенсорного пульта (телефон) — та сама модель, що й у клавіатури
  press(code: string): void
  release(code: string): void
}

export function createInput(target: Window): Input {
  const down = new Set<string>() // клавіші, затиснуті зараз
  const pressed = new Set<string>() // клавіші, натиснуті з моменту останнього consume()

  // у полі вводу (ім'я пілота в лобі) клавіші належать полю, а не грі
  const isTyping = (e: Event): boolean =>
    e.target instanceof Element && e.target.closest('input, textarea, button') !== null

  target.addEventListener('keydown', (e) => {
    if (isTyping(e)) return
    if (GAME_KEYS.has(e.code)) e.preventDefault()
    if (!down.has(e.code)) pressed.add(e.code) // автоповтор клавіші не рахуємо як нове натискання
    down.add(e.code)
  })

  target.addEventListener('keyup', (e) => {
    down.delete(e.code)
  })

  // якщо вкладка втратила фокус, keyup може не прийти — "залипла" б тяга
  target.addEventListener('blur', () => down.clear())

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    // викликається в кінці кожного кроку симуляції: "натискання" живе рівно один крок
    consume: () => pressed.clear(),
    press(code) {
      if (!down.has(code)) pressed.add(code)
      down.add(code)
    },
    release(code) {
      down.delete(code)
    },
  }
}
