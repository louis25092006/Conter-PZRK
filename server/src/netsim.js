// Імітатор поганої мережі для одного з'єднання (Lab 5, розділ 7).
// На localhost затримка ~0 мс і будь-який мережевий код "працює". Тому штучно:
//   lag    — додаткова затримка ТУДИ-І-НАЗАД (мс), по lag/2 у кожен бік;
//   jitter — випадкова добавка 0..jitter мс до кожного повідомлення;
//   drop   — частка ЗНІМКІВ, що "губляться" (0..0.5). Команди, чат і т.п. не губимо:
//            WebSocket працює поверх TCP, а TCP нічого не губить — він лише запізнюється.
// Порядок повідомлень зберігається (як у TCP): кожне наступне не раніше попереднього.

export function createLink({ lag = 0, jitter = 0, drop = 0 } = {}, random = Math.random) {
  const cfg = { lag, jitter, drop }
  const stats = { dropped: 0 }

  const delay = () => cfg.lag / 2 + random() * cfg.jitter
  const active = () => cfg.lag > 0 || cfg.jitter > 0

  // Черга FIFO з ОДНИМ таймером на кожен напрямок.
  // Раніше кожне повідомлення мало свій setTimeout — і порядок ламався: Node округлює
  // затримку до цілих мс, тож пізніше повідомлення з трохи меншою затримкою спрацьовувало
  // раніше. Команди гравця мінялись місцями, сервер відкидав "застарілу" (менший seq),
  // і передбачення розходилось на крок (~5 px). У TCP такого не буває — отже, і тут не можна.
  function createQueue() {
    const items = [] // { at, fn }, at не спадає
    let timer = null
    let lastAt = 0
    function pump() {
      timer = null
      const now = performance.now()
      while (items.length && items[0].at <= now + 0.5) items.shift().fn()
      if (items.length) timer = setTimeout(pump, Math.max(0, items[0].at - now))
    }
    return (fn) => {
      const now = performance.now()
      lastAt = Math.max(lastAt, now + delay()) // кожне наступне — не раніше попереднього
      items.push({ at: lastAt, fn })
      if (!timer) timer = setTimeout(pump, Math.max(0, items[0].at - now))
    }
  }
  const outQueue = createQueue()
  const inQueue = createQueue()

  return {
    config: cfg,
    stats,
    set({ lag, jitter, drop }) {
      cfg.lag = clamp(lag, 0, 1000)
      cfg.jitter = clamp(jitter, 0, 500)
      cfg.drop = clamp(drop, 0, 0.5)
    },
    // вихідне повідомлення (сервер → клієнт)
    out(send, { droppable = false } = {}) {
      if (droppable && cfg.drop > 0 && random() < cfg.drop) {
        stats.dropped++
        return
      }
      if (!active()) return send()
      outQueue(send)
    },
    // вхідне повідомлення (клієнт → сервер)
    in(handle) {
      if (!active()) return handle()
      inQueue(handle)
    },
  }
}

function clamp(v, min, max) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
}

// параметри з адреси WebSocket: /ws?lag=100&jitter=30&drop=0.02&codec=binary
export function parseNetParams(url) {
  const q = new URL(url, 'http://localhost').searchParams
  return {
    lag: Number(q.get('lag') ?? 0),
    jitter: Number(q.get('jitter') ?? 0),
    drop: Number(q.get('drop') ?? 0),
    codec: q.get('codec') === 'json' ? 'json' : 'binary',
  }
}
