// Lab 7, M3: flame graph у SVG з .cpuprofile (сервер — node --cpu-prof, клієнт — CDP Profiler).
//   node scripts/flamegraph.ts <file.cpuprofile> <out.svg> [--title "..."]
// Ширина прямокутника = скільки часу функція (разом з усім, що вона викликала) була на стеку;
// знизу — корінь, угору — хто кого викликав. Простій (idle) не малюємо: він «з'їв» би все полотно.
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { z } from 'zod'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { title: { type: 'string', default: '' } },
})
const [file, out] = positionals
if (!file || !out) throw new Error('usage: node scripts/flamegraph.ts <in.cpuprofile> <out.svg>')

const Node = z.object({
  id: z.number(),
  callFrame: z.object({ functionName: z.string(), url: z.string(), lineNumber: z.number() }),
  children: z.array(z.number()).optional(),
})
const Profile = z.object({
  nodes: z.array(Node),
  samples: z.array(z.number()),
  timeDeltas: z.array(z.number()),
})
const profile = Profile.parse(JSON.parse(readFileSync(file, 'utf8')))

const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
const selfUs = new Map<number, number>()
profile.samples.forEach((id, i) => selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)))

const SKIP = new Set(['(idle)', '(program)', '(garbage collector)'])
const label = (id: number): string => {
  const f = nodes.get(id)?.callFrame
  if (!f) return '?'
  const file = f.url
    .replace(/\?.*$/, '')
    .replace(/^.*\/(shared|server|client)\/src\//, '$1/')
    .replace(/^.*\//, '')
  return `${f.functionName || '(anonymous)'}${file ? ` ${file}:${f.lineNumber + 1}` : ''}`
}
// загальний час вузла = свій + усіх нащадків
const totalUs = new Map<number, number>()
function total(id: number): number {
  const cached = totalUs.get(id)
  if (cached !== undefined) return cached
  const n = nodes.get(id)
  let t = SKIP.has(n?.callFrame.functionName ?? '') ? 0 : (selfUs.get(id) ?? 0)
  for (const c of n?.children ?? []) t += total(c)
  totalUs.set(id, t)
  return t
}
const root = profile.nodes[0]
if (!root) throw new Error('empty profile')
const rootTotal = total(root.id)

const W = 1200
const ROW = 18
const rects: string[] = []
let maxDepth = 0
function color(name: string): string {
  if (name.includes('shared/')) return '#e8a33d'
  if (name.includes('server/')) return '#d9663f'
  if (name.includes('client/')) return '#e0c341'
  if (name.startsWith('(') || name.includes('node:')) return '#9aa7b8'
  return '#c97b5a'
}
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const MAX_DEPTH = 30 // глибші стеки (async-ланцюжки) обрізаємо — картинка лишається читабельною
function draw(id: number, x: number, depth: number): void {
  if (depth > MAX_DEPTH) return
  const t = total(id)
  if (t <= 0) return
  const w = (t / rootTotal) * W
  if (w < 0.5) return
  maxDepth = Math.max(maxDepth, depth)
  const name = depth === 0 ? 'all (без простою)' : label(id)
  const pct = ((t / rootTotal) * 100).toFixed(1)
  rects.push(
    `<g><title>${esc(name)} — ${(t / 1000).toFixed(0)} ms (${pct}%)</title><rect x="${x.toFixed(1)}" y="__Y${depth}__" width="${w.toFixed(1)}" height="${ROW - 1}" fill="${color(name)}" rx="2"/>` +
      (w > 60
        ? `<text x="${(x + 4).toFixed(1)}" y="__T${depth}__" font-size="11" fill="#111">${esc(name.slice(0, Math.floor(w / 6.5)))}</text>`
        : '') +
      '</g>',
  )
  let cx = x
  for (const c of nodes.get(id)?.children ?? []) {
    draw(c, cx, depth + 1)
    cx += (total(c) / rootTotal) * W
  }
}
draw(root.id, 0, 0)
const H = (maxDepth + 1) * ROW + 40
const body = rects
  .join('\n')
  .replace(/__Y(\d+)__/g, (_, d: string) => String(H - 10 - (Number(d) + 1) * ROW))
  .replace(/__T(\d+)__/g, (_, d: string) => String(H - 10 - (Number(d) + 1) * ROW + 13))
writeFileSync(
  out,
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="monospace">
<rect width="100%" height="100%" fill="#fdfaf3"/>
<text x="6" y="18" font-size="13" fill="#333">${esc(values.title)} — ${(rootTotal / 1e6).toFixed(1)} s CPU (простій не показано); наведіть на блок, щоб побачити час</text>
${body}
</svg>
`,
)
console.log(`written ${out}: ${rects.length} frames, depth ${maxDepth}`)
