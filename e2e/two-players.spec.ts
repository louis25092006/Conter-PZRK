import { test, expect, type Page } from '@playwright/test'

// Два гравці = два ізольовані контексти браузера (як два різні комп'ютери).
// Стан гри читаємо через window.game, який main.ts виставляє лише в dev-режимі.

interface ShipPos {
  x: number
  y: number
}

// Код усередині page.evaluate виконується В БРАУЗЕРІ і серіалізується як текст,
// тож помічники мають бути всередині. Типів window.game тут немає — читаємо як unknown
// і звужуємо перевірками (без приведень типів).
function netGameField(page: Page, path: readonly string[]): Promise<unknown> {
  return page.evaluate((keys) => {
    let cur: unknown = Reflect.get(window, 'game')
    for (const k of keys) cur = typeof cur === 'object' && cur !== null ? Reflect.get(cur, k) : undefined
    return cur
  }, path)
}

// позиція літака shipId в ОСТАННЬОМУ знімку, який отримав цей клієнт
function shipInLastSnapshot(page: Page, shipId: number): Promise<ShipPos | null> {
  return page.evaluate((id) => {
    const at = (o: unknown, k: string | number): unknown =>
      typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined
    const snaps = at(at(at(Reflect.get(window, 'game'), 'session'), 'game'), 'snapshots')
    if (!Array.isArray(snaps) || snaps.length === 0) return null
    const map = at(snaps.at(-1), 'map')
    if (!(map instanceof Map)) return null
    const e: unknown = map.get(id)
    const x = at(e, 'x')
    const y = at(e, 'y')
    return typeof x === 'number' && typeof y === 'number' ? { x, y } : null
  }, shipId)
}
async function myShipId(page: Page): Promise<number | null> {
  const you = await netGameField(page, ['session', 'game', 'you'])
  return typeof you === 'number' ? you : null
}

test('двоє гравців: ростер, рух видно в іншому браузері за ≤ 500 мс, чат', async ({ browser }) => {
  const room = `r-training`
  const alice = await (await browser.newContext()).newPage()
  const bob = await (await browser.newContext()).newPage()
  await alice.goto(`/?autojoin=${room}&name=Alice`)
  await bob.goto(`/?autojoin=${room}&name=Bob`)

  // 1) обидва бачать обох у списку кімнати
  for (const page of [alice, bob]) {
    await expect(page.locator('.roster li', { hasText: 'Alice' })).toBeVisible()
    await expect(page.locator('.roster li', { hasText: 'Bob' })).toBeVisible()
  }

  // 2) Alice летить — Bob бачить, що її літак зрушив, не пізніше ніж за 500 мс
  await expect.poll(() => myShipId(alice)).not.toBeNull()
  const aliceId = await myShipId(alice)
  if (aliceId === null) throw new Error('no ship id')
  await expect.poll(() => shipInLastSnapshot(bob, aliceId)).not.toBeNull()
  const before = await shipInLastSnapshot(bob, aliceId)
  if (!before) throw new Error('Bob does not see Alice')

  await alice.keyboard.down('KeyW')
  const started = Date.now()
  await expect
    .poll(
      async () => {
        const now = await shipInLastSnapshot(bob, aliceId)
        return now ? Math.hypot(now.x - before.x, now.y - before.y) : 0
      },
      { timeout: 500, intervals: [20] },
    )
    .toBeGreaterThan(1)
  const seenAfter = Date.now() - started
  await alice.keyboard.up('KeyW')
  console.log(`Bob saw Alice move after ${seenAfter} ms`)

  // 3) чат: Alice пише — Bob отримує
  await alice.keyboard.press('Enter')
  await alice.locator('.chat-input').fill('привіт, Bob!')
  await alice.keyboard.press('Enter')
  await expect(bob.locator('.chat-log')).toContainText('Alice: привіт, Bob!')
})

// Lab 8: телефон (PWA) — сенсорний пульт керує літаком так само, як клавіатура
test('телефон: сенсорні кнопки керують літаком, маніфест PWA на місці', async ({ browser }) => {
  const phone = await (
    await browser.newContext({ viewport: { width: 740, height: 360 }, hasTouch: true, isMobile: true })
  ).newPage()
  await phone.goto('/?autojoin=r-dogfight&name=Phone')
  await expect(phone.locator('.touch-controls button')).toHaveCount(5)
  await expect.poll(() => myShipId(phone)).not.toBeNull()

  const speed = (): Promise<number> =>
    phone.evaluate(() => {
      const at = (o: unknown, k: string): unknown =>
        typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined
      const p = at(at(at(Reflect.get(window, 'game'), 'session'), 'game'), 'predicted')
      const vx = at(p, 'vx')
      const vy = at(p, 'vy')
      return typeof vx === 'number' && typeof vy === 'number' ? Math.hypot(vx, vy) : 0
    })
  const thrust = phone.getByRole('button', { name: 'Газ' })
  await thrust.dispatchEvent('pointerdown', { pointerId: 1, isPrimary: true })
  await expect.poll(speed, { timeout: 2000 }).toBeGreaterThan(20)
  await thrust.dispatchEvent('pointerup', { pointerId: 1, isPrimary: true })

  const manifest = await phone.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]')?.getAttribute('href') ?? ''
    const res = await fetch(href)
    const json: unknown = await res.json()
    return json
  })
  expect(manifest).toMatchObject({ short_name: 'Conter-PZRK', display: 'fullscreen' })
})
