// Екран завантаження на canvas: справжній прогрес-бар + список проблем.

function describe(error) {
  if (!error) return ''
  if (error.name === 'HttpError') return `HTTP ${error.status}`
  if (error.name === 'TimeoutError') return 'таймаут'
  if (error.name === 'AssetFormatError') return 'зіпсований файл'
  if (error.name === 'AbortError') return 'скасовано'
  return error.message
}

const FALLBACK = {
  image: 'буде векторна графіка',
  audio: 'гра буде без цього звуку',
  json: '',
}

export function drawLoadingScreen(ctx, s) {
  const w = ctx.canvas.clientWidth
  const h = ctx.canvas.clientHeight
  const cx = w / 2
  const barW = Math.min(420, w - 80)
  const barY = h / 2 - 10

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = 'white'
  ctx.font = 'bold 30px monospace'
  ctx.fillText('Conter-PZRK', cx, barY - 60)

  // смуга прогресу
  const progress = s.total ? s.done / s.total : 0
  ctx.fillStyle = '#1f2937'
  ctx.fillRect(cx - barW / 2, barY, barW, 16)
  ctx.fillStyle = s.phase === 'error' ? '#ef4444' : s.phase === 'cancelled' ? '#9ca3af' : '#4a90d9'
  ctx.fillRect(cx - barW / 2, barY, barW * progress, 16)
  ctx.strokeStyle = '#4b5563'
  ctx.strokeRect(cx - barW / 2 + 0.5, barY + 0.5, barW - 1, 15)

  ctx.font = '14px monospace'
  ctx.fillStyle = '#d1d5db'
  const label = {
    manifest: 'Завантажую маніфест…',
    loading: `Завантаження ${s.done}/${s.total} · ${Math.round(progress * 100)}% · ${(s.elapsedMs / 1000).toFixed(1)} с`,
    done: `Готово: ${s.total} файлів за ${(s.elapsedMs / 1000).toFixed(2)} с`,
    error: 'Не вдалося завантажити гру',
    cancelled: 'Завантаження скасовано',
  }[s.phase]
  ctx.fillText(label, cx, barY + 40)
  if (s.lastItem && s.phase === 'loading') {
    ctx.fillStyle = '#6b7280'
    ctx.fillText(s.lastItem, cx, barY + 60)
  }

  // проблеми: що не завантажилось і що буде замість цього
  let y = barY + 95
  ctx.font = '13px monospace'
  for (const r of s.retries.slice(-3)) {
    ctx.fillStyle = '#93c5fd'
    ctx.fillText(
      `↻ ${r.item.key}: ${describe(r.error)}, повтор №${r.attempt} через ${Math.round(r.delay)} мс`,
      cx,
      y,
    )
    y += 18
  }
  for (const f of s.failed) {
    ctx.fillStyle = '#fbbf24'
    ctx.fillText(`⚠ ${f.item.key}: ${describe(f.error)} — ${FALLBACK[f.item.type]}`, cx, y)
    y += 18
  }
  if (s.error) {
    ctx.fillStyle = '#f87171'
    ctx.fillText(`✖ ${s.error.message}`, cx, y + 6)
    // маніфест лежить у public/ — його віддає лише Vite (npm run dev),
    // а не Live Server чи відкритий напряму index.html
    if (s.error.name === 'HttpError' && s.error.url?.includes('manifest.json')) {
      ctx.fillStyle = '#9ca3af'
      ctx.fillText('Запусти гру через "npm run dev" і відкрий http://localhost:5173', cx, y + 30)
    }
  }
}
