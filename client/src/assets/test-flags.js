// Навмисні збої для "галереї помилок" (README, Lab 3 M4).
// Вмикаються параметром адреси, наприклад:  http://localhost:5173/?test=missing,slow
//
//   missing    — спрайт літаків замінено на файл, якого немає (404, без повторів)
//   slow       — спрайт астероїдів відповідає через 2.5 с (видно, як іде прогрес)
//   slowall    — КОЖЕН ассет відповідає через 400 мс (для заміру паралельно vs послідовно)
//   timeout    — звук вибуху відповідає через 8 с при таймауті 1.5 с (3 спроби → тиша)
//   flaky      — звук пострілу двічі віддає 503, на третій раз — успіх (видно повтори)
//   badjson    — конфіг арен зіпсований (обов'язковий ассет → екран помилки з кнопкою Retry)
//   abort      — завантаження скасовується через 1 с (як натиснути Cancel); разом зі slow — посеред завантаження
//   sequential — вантажити по черзі замість Promise.all
//   lobbyslow  — список кімнат відповідає через 5 с при таймауті 3 с
//
// Затримки й 503 робить middleware у vite.config.js (параметри ?delay= і ?fail=).

export function readTestFlags(search) {
  const raw = new URLSearchParams(search).get('test')
  return new Set(raw ? raw.split(',').map((s) => s.trim()) : [])
}

function addQuery(url, params) {
  const sep = url.includes('?') ? '&' : '?'
  return url + sep + new URLSearchParams(params).toString()
}

export function applyTestFlags(manifest, flags) {
  if (flags.size === 0) return manifest
  // run — щоб лічильник ?fail= на сервері був свій для кожного завантаження сторінки
  const run = Math.random().toString(36).slice(2, 8)
  const items = manifest.items.map((item) => {
    let { url } = item
    const extra = {}
    if (flags.has('missing') && item.key === 'ships') url = 'sprites/does-not-exist.svg'
    if (flags.has('slow') && item.key === 'asteroids') url = addQuery(url, { delay: 2500 })
    if (flags.has('slowall')) url = addQuery(url, { delay: 400 })
    if (flags.has('timeout') && item.key === 'explosion') {
      url = addQuery(url, { delay: 8000 })
      extra.timeoutMs = 1500
    }
    if (flags.has('flaky') && item.key === 'shoot') url = addQuery(url, { fail: 2, run })
    if (flags.has('badjson') && item.key === 'arenas') url = 'broken.json'
    return { ...item, ...extra, url }
  })
  return { ...manifest, items }
}
