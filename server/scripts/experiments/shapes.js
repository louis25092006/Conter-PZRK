// Lab 7, дослід 2: одна «форма» об'єктів проти двох і проти Float32Array. node scripts/experiments/shapes.js
const N = 1_000_000
const mono = Array.from({ length: N }, (_, i) => ({ x: i, y: i }))
const poly = Array.from({ length: N }, (_, i) => (i % 10 === 0 ? { x: i, y: i, z: i } : { x: i, y: i }))
const xs = new Float32Array(N).map((_, i) => i)
function sumObjects(arr) {
  let s = 0
  for (let i = 0; i < arr.length; i++) s += arr[i].x
  return s
}
function sumTyped(a) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return s
}
function bench(name, fn) {
  for (let i = 0; i < 20; i++) fn() // розігрів
  const t = []
  for (let r = 0; r < 50; r++) {
    const t0 = performance.now()
    fn()
    t.push(performance.now() - t0)
  }
  t.sort((a, b) => a - b)
  console.log(`${name.padEnd(28)} median ${t[25].toFixed(3)} ms   p95 ${t[47].toFixed(3)} ms`)
}
bench('mono {x,y}', () => sumObjects(mono))
bench('poly (кожен 10-й з .z)', () => sumObjects(poly))
bench('Float32Array', () => sumTyped(xs))
