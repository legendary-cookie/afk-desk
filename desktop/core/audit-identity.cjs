'use strict'
const { randomBytes, createHmac } = require('node:crypto')
// Never persist an authentication handle. Correlation lasts only for this process.
const key = randomBytes(32)
function auditActor(actor = {}) {
  return {
    kind: actor.kind || 'anonymous',
    id: createHmac('sha256', key).update(`${actor.kind}:${actor.id}`).digest('hex').slice(0, 24),
    scope: actor.scope || 'none',
    ip: redactAuditText(String(actor.ip || ''))
  }
}
function redactAuditText(value) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/afk_[A-Za-z0-9_-]+|[0-9a-f]{64}|[0-9a-f]{48}/gi, '[redacted-credential]')
}
module.exports = { auditActor, redactAuditText }
