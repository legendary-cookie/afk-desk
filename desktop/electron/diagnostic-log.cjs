const fs = require('node:fs')
const path = require('node:path')

class DiagnosticLog {
  constructor(userDataPath, { maxBytes = 2 * 1024 * 1024 } = {}) {
    this.file = path.join(userDataPath, 'diagnostics', 'movement-diagnostics.jsonl')
    this.maxBytes = maxBytes
  }

  write(entry) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      if (fs.existsSync(this.file) && fs.statSync(this.file).size >= this.maxBytes) {
        fs.writeFileSync(this.file, '', 'utf8')
      }
      fs.appendFileSync(this.file, `${JSON.stringify(redactDiagnostic(entry))}\n`, 'utf8')
    } catch {}
  }
}

function redactDiagnostic(value, key = '') {
  if (/password|token|secret|authorization|username/i.test(key)) return '[redacted]'
  if (typeof value === 'string') {
    return value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
      .replace(/bearer\s+[A-Z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
      .slice(0, 2000)
  }
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => redactDiagnostic(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 256).map(([childKey, child]) => [childKey, redactDiagnostic(child, childKey)]))
  }
  return value
}

module.exports = { DiagnosticLog, redactDiagnostic }
