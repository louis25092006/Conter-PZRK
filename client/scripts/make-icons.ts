// Lab 8: PNG-іконки для PWA з public/icons/icon.svg (Chromium малює SVG — і робимо знімок).
//   node scripts/make-icons.ts
// maskable-версія: той самий малюнок, зменшений до «безпечної зони» 80% (лаунчер обріже краї кругом).
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../public/icons/', import.meta.url))
const svg = readFileSync(`${dir}icon.svg`, 'utf8')
const browser = await chromium.launch()
try {
  for (const { file, size, inset } of [
    { file: 'icon-192.png', size: 192, inset: 0 },
    { file: 'icon-512.png', size: 512, inset: 0 },
    { file: 'icon-maskable-512.png', size: 512, inset: 0.1 },
  ]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    const pad = Math.round(size * inset)
    await page.setContent(
      `<body style="margin:0;background:#2a1f45"><div style="padding:${pad}px;width:${size - 2 * pad}px;height:${size - 2 * pad}px">${svg.replace('<svg ', `<svg width="${size - 2 * pad}" height="${size - 2 * pad}" `)}</div></body>`,
    )
    await page.screenshot({ path: `${dir}${file}` })
    await page.close()
    console.log(`written icons/${file}`)
  }
} finally {
  await browser.close()
}
