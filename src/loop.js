export function createLoop({ step = 1 / 60, simulate, render }) {
  let accumulator = 0        
  let lasttime = 0                
  let rafId = null            

  //HUD
  let stepsThisSecond = 0
  let framesThisSecond = 0
  let statsTimer = 0
  const stats = { stepsPerSec: 0, framesPerSec: 0, frameMs: 0 }

  function frame(now) {
    const frameStart = performance.now()

    if (lasttime === 0) lasttime = now   
    const delta = Math.min((now - lasttime) / 1000, 0.25)  
    lasttime = now
    accumulator += delta

    while (accumulator >= step) {
      simulate(step)            
      accumulator -= step
      stepsThisSecond++
    }

    render(accumulator / step)   // alpha
    framesThisSecond++

    // обнов стат
    statsTimer += delta
    if (statsTimer >= 1) {
      stats.stepsPerSec = stepsThisSecond
      stats.framesPerSec = framesThisSecond
      stepsThisSecond = 0
      framesThisSecond = 0
      statsTimer = 0
    }
    stats.frameMs = performance.now() - frameStart

    rafId = requestAnimationFrame(frame)
  }

  return {
    start() { rafId = requestAnimationFrame(frame) },
    stop() { cancelAnimationFrame(rafId) },
    stats  
  }
}