import { ARENA_SIZE } from '../../../shared/src/sim/arena.ts'

// Lab 5: арена фіксована (1600×900) і однакова для всіх гравців.
// Камера вписує її у вікно браузера зі збереженням пропорцій (по краях — рамка).
export interface Camera {
  readonly s: number
  readonly ox: number
  readonly oy: number
  readonly width: number
  readonly height: number
  toScreen(x: number, y: number): { x: number; y: number }
  apply(ctx: CanvasRenderingContext2D): void
}

export function computeCamera(viewW: number, viewH: number, { width, height } = ARENA_SIZE): Camera {
  const s = Math.min(viewW / width, viewH / height)
  const ox = (viewW - width * s) / 2
  const oy = (viewH - height * s) / 2
  return {
    s,
    ox,
    oy,
    width,
    height,
    toScreen: (x: number, y: number) => ({ x: ox + x * s, y: oy + y * s }),
    apply(ctx: CanvasRenderingContext2D) {
      ctx.translate(ox, oy)
      ctx.scale(s, s)
    },
  }
}

// фон арени: небо кольору арени + тонка рамка межі
export function drawArenaBackground(ctx: CanvasRenderingContext2D, cam: Camera, sky = '#000'): void {
  ctx.fillStyle = '#05060a' // поле поза ареною
  ctx.fillRect(0, 0, ctx.canvas.clientWidth, ctx.canvas.clientHeight)
  ctx.save()
  cam.apply(ctx)
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, cam.width, cam.height)
  ctx.restore()
}

export function drawArenaBorder(ctx: CanvasRenderingContext2D, cam: Camera): void {
  ctx.save()
  cam.apply(ctx)
  ctx.strokeStyle = 'rgba(245, 184, 61, 0.25)'
  ctx.lineWidth = 2 / cam.s
  ctx.strokeRect(0, 0, cam.width, cam.height)
  ctx.restore()
}
