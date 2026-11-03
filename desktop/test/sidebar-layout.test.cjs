const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8')

test('sidebar holds only account navigation, add account and settings (narrow rail stays clean)', () => {
  const sidebar = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'))
  for (const id of ['bulk-appearance-open', 'import-profile-share', 'open-help-tour']) assert.ok(!sidebar.includes(`id="${id}"`), `${id} must not be in the sidebar`)
  for (const id of ['bulk-appearance-open', 'import-profile-share', 'open-help-tour']) assert.ok(html.includes(`id="${id}"`), `${id} must still exist`)
})

test('interface scale can go down to 50%', () => {
  for (const id of ['quick-scale', 'quick-scale-number', 'ui-scale']) assert.match(html, new RegExp(`id="${id}"[^>]*min="50"`))
})
