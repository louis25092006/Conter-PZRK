// Lab 7, M3: «Bottom-Up» з .cpuprofile без DevTools — функції, відсортовані за self time.
//   node scripts/cpuprofile-top.ts scripts/profiles/CPU.xxx.cpuprofile [--top 15]
// Формат .cpuprofile: дерево вузлів (функція + місце в коді), список семплів (id вузла, на якому
// був процесор у момент семплу) і проміжки часу між семплами. Self time вузла = сума проміжків,
// коли процесор був САМЕ в ньому (а не в тих, кого він викликав).
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { z } from 'zod'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { top: { type: 'string', default: '15' } },
})
const file = positionals[0]
if (!file) throw new Error('usage: node scripts/cpuprofile-top.ts <file.cpuprofile>')

const Profile = z.object({
  nodes: z.array(
    z.object({
      id: z.number(),
      callFrame: z.object({ functionName: z.string(), url: z.string(), lineNumber: z.number() }),
    }),
  ),
  samples: z.array(z.number()),
  timeDeltas: z.array(z.number()),
})
const profile = Profile.parse(JSON.parse(readFileSync(file, 'utf8')))

const byNode = new Map<number, string>()
for (const n of profile.nodes) {
  const { functionName, url, lineNumber } = n.callFrame
  const short = url.replace(/^.*\/(shared|server|client|node_modules)\//, '$1/').replace(/^node:/, 'node:')
  byNode.set(n.id, `${functionName || '(anonymous)'}  ${short ? `${short}:${lineNumber + 1}` : ''}`.trim())
}
const self = new Map<string, number>()
let total = 0
profile.samples.forEach((id, i) => {
  const dt = profile.timeDeltas[i] ?? 0
  total += dt
  const key = byNode.get(id) ?? '?'
  self.set(key, (self.get(key) ?? 0) + dt)
})
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(values.top))
console.log(`total ${(total / 1e6).toFixed(1)} s sampled\n`)
console.log('| self ms | % | function |')
console.log('|---|---|---|')
for (const [name, us] of rows)
  console.log(`| ${(us / 1000).toFixed(0)} | ${((us / total) * 100).toFixed(1)} | \`${name}\` |`)
