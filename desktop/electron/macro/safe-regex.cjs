'use strict'
// Conservative: one repetition at most prevents overlapping repetitions from
// causing exponential backtracking. Backreferences and assertions are excluded.
function safeRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 200 || /\\[1-9]|\(\?/.test(pattern)) return false
  let escaped = false, inClass = false, repetitions = 0
  const groups = []
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (escaped) { escaped = false; continue }
    if (c === '\\') { escaped = true; continue }
    if (c === '[') { inClass = true; continue }
    if (c === ']' && inClass) { inClass = false; continue }
    if (inClass) continue
    if (c === '(') groups.push({ alternative: false })
    if (c === '|') for (const group of groups) group.alternative = true
    if (c === ')') {
      const group = groups.pop()
      if (group?.alternative && /^[*+?{]/.test(pattern.slice(i + 1))) return false
    }
    if (c === '*' || c === '+' || c === '?' || (c === '{' && /^\{\d+(?:,\d*)?\}/.test(pattern.slice(i)))) {
      if (++repetitions > 1) return false
    }
  }
  try { new RegExp(pattern); return true } catch { return false }
}
module.exports = { safeRegex }
