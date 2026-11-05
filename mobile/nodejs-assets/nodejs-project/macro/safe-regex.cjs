'use strict'
// Deliberately conservative: repeated groups cannot contain repetition or
// alternation, and separate repetitions need a literal punctuation separator.
function safeRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 200 || /\\[1-9]|\(\?/.test(pattern)) return false
  let inClass = false, escaped = false, separator = false, repeated = false
  const groups = []
  let lastGroup = null
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (escaped) { escaped = false; lastGroup = null; continue }
    if (c === '\\') { escaped = true; continue }
    if (c === '[' && !inClass) { inClass = true; lastGroup = null; continue }
    if (c === ']' && inClass) { inClass = false; continue }
    if (inClass) continue
    if (c === '(') { groups.push({ repetition: false, alternative: false }); lastGroup = null; continue }
    if (c === '|') { for (const group of groups) group.alternative = true; lastGroup = null; continue }
    if (c === ')') { lastGroup = groups.pop(); continue }
    const quantifier = c === '*' || c === '+' || c === '?' || (c === '{' && /^\{\d+(?:,\d*)?\}/.test(pattern.slice(i)))
    if (quantifier) {
      if (lastGroup && (lastGroup.repetition || lastGroup.alternative)) return false
      if (repeated && !separator) return false
      for (const group of groups) group.repetition = true
      repeated = true; separator = false; lastGroup = null
      if (c === '{') i += /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i))[0].length - 1
      continue
    }
    if (repeated && /[_\-/: ]/.test(c)) separator = true
    lastGroup = null
  }
  try { new RegExp(pattern); return true } catch { return false }
}
module.exports = { safeRegex }
