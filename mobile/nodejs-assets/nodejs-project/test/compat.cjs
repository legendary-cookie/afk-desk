// Test-only helpers so the engine suite runs on the embedded Android runtime
// (nodejs-mobile, Node 18.20.4) as well as on the desktop host Node.

// Promise.withResolvers is Node 22+.
function withResolvers() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// node:test mock timers: Node 18 takes an array of API names,
// Node 20.4+ takes { apis: [...] }.
function enableTimers(t, apis) {
  try {
    t.mock.timers.enable({ apis })
  } catch (error) {
    if (error?.code !== 'ERR_INVALID_ARG_TYPE') throw error
    t.mock.timers.enable(apis)
  }
}

// Node 18's experimental MockTimers does not fire due timers from tick() when
// several timers are pending (only runAll() fires them); fixed in Node 20.
// Tests that depend on tick() are skipped there, with this reason shown.
const nodeMajor = Number(process.versions.node.split('.')[0])
const mockTickSkip = nodeMajor < 20 ? 'node:test MockTimers tick() is unreliable on Node ' + process.versions.node + ' (fixed in Node 20)' : false

module.exports = { withResolvers, enableTimers, mockTickSkip }
