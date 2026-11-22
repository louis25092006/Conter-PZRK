// Canvas з урахуванням devicePixelRatio (чітко на retina) і зміни розміру вікна.
export function setupCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is not supported in this browser')

  function resize(): void {
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = window.innerWidth * dpr
    canvas.height = window.innerHeight * dpr
    canvas.style.width = window.innerWidth + 'px'
    canvas.style.height = window.innerHeight + 'px'
    ctx.scale(dpr, dpr)
  }

  resize()
  window.addEventListener('resize', resize)
  return ctx
}

// елемент сторінки потрібного типу або зрозуміла помилка (замість `as HTMLCanvasElement`)
export function requireElement<T extends Element>(id: string, type: abstract new () => T): T {
  const el = document.getElementById(id)
  if (!(el instanceof type)) throw new Error(`#${id} is missing or is not a ${type.name}`)
  return el
}
