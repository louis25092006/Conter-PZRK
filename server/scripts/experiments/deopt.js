// Lab 7, дослід 1: оптимізація і деоптимізація. Запуск: node --allow-natives-syntax scripts/experiments/deopt.js
// ';' перед %-викликами обов'язкова: без неї ASI склеїть рядок з попереднім як «a % b»
function add(a, b) {
  return a + b
}
const bits = (s) => ({
  isFunction: !!(s & 1),
  neverOptimize: !!(s & 2),
  alwaysOptimize: !!(s & 4),
  maybeDeopted: !!(s & 8),
  optimized: !!(s & 16),
  turboFanned: !!(s & 32),
  interpreted: !!(s & 64),
  markedForOptimization: !!(s & 128),
})
;%PrepareFunctionForOptimization(add)
add(1, 2)
add(3, 4)
;%OptimizeFunctionOnNextCall(add)
add(5, 6)
const s1 = %GetOptimizationStatus(add)
console.log('після add(5, 6) з числами:', s1.toString(2), bits(s1))
add('a', 'b') // інший тип — припущення TurboFan «тут лише числа» порушено
const s2 = %GetOptimizationStatus(add)
console.log("після add('a', 'b'):     ", s2.toString(2), bits(s2))
