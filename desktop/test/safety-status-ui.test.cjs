'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { maskText } = require('../src/streamer-mask.js')

test('account details safety status uses textContent and streamer masking', () => {
  const renderer = fs.readFileSync(require.resolve('../src/renderer.js'), 'utf8')
  const html = fs.readFileSync(require.resolve('../src/index.html'), 'utf8')
  const line = renderer.split('\n').find(line => line.includes("setDetailValue('detail-safety',"))
  assert.ok(line)
  assert.match(html, /<dt>Safety status<\/dt><dd id="detail-safety">/)
  const element = { textContent: '' }
  Object.defineProperty(element, 'innerHTML', { set() { assert.fail('Untrusted status must remain plain text') } })
  const message = 'StarrySea <img src=x onerror=alert(1)> failed'
  const context = { el: { 'detail-safety': element }, telemetry: { safetyStatus: message }, maskText: text => maskText(text, [{ id: 'a', minecraftName: 'StarrySea' }], true) }
  vm.runInNewContext(renderer.slice(renderer.indexOf('function setDetailValue('), renderer.indexOf('function renderTelemetry(')), context)
  vm.runInNewContext(line, context)
  assert.doesNotMatch(element.textContent, /StarrySea/)
  assert.match(element.textContent, /<img src=x onerror=alert\(1\)>/)
  assert.equal(element.title, element.textContent)
  context.telemetry = undefined
  vm.runInNewContext(line, context)
  assert.equal(element.textContent, '—')
  assert.equal(element.title, '—')
})

test('mobile account details renders masked safety status as Text through Stat', () => {
  const app = fs.readFileSync(require.resolve('../../mobile/App.tsx'), 'utf8')
  assert.match(app, /<Stat label="Safety status" value=\{mask\(session\?\.telemetry\?\.safetyStatus \|\| '—'\)\} wide/)
})
