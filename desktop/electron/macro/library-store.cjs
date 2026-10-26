'use strict'
const fs = require('node:fs')
const path = require('node:path')
const model = require('./model.cjs')

class MacroLibraryStore {
  constructor(userDataPath) { this.file = path.join(userDataPath, 'macros.json'); this.library = { version: 2, macros: [] }; this.warnings = [] }
  load(accounts = []) {
    let raw
    try { raw = fs.readFileSync(this.file, 'utf8') }
    catch (error) {
      if (error.code !== 'ENOENT') this._recover(error, accounts)
      else this.library = model.normalizeLibrary({ macros: [] })
      return this.library
    }
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 2 || !Array.isArray(parsed.macros)) throw new Error('Invalid macro library schema')
      this.library = model.normalizeLibrary(parsed)
    } catch (error) { this._recover(error, accounts) }
    return this.library
  }
  _recover(error, accounts) {
    let backup = ''
    try { backup = `${this.file}.corrupt-${Date.now()}`; fs.renameSync(this.file, backup) }
    catch (renameError) { backup = `${this.file} (could not move: ${renameError.message})` }
    const migrated = model.migrateV1(accounts, model.normalizeLibrary({ macros: [] }))
    this.library = migrated.library
    this.warnings.push(`Macro library was unreadable (${error.message}); rebuilt from account automations. Backup: ${backup}`)
    this.write(this.library)
  }
  list() { return this.library.macros.slice() }
  get(id) { return this.library.macros.find((macro) => macro.id === id) || null }
  save(macro) { const next = this.list(); const index = next.findIndex((item) => item.id === macro.id); if (index < 0) next.push(macro); else next[index] = macro; this.library = model.normalizeLibrary({ ...this.library, macros: next }); this.write(this.library); return this.get(macro.id) }
  remove(id) { const before = this.library.macros.length; this.library = model.normalizeLibrary({ ...this.library, macros: this.library.macros.filter((m) => m.id !== id) }); if (before !== this.library.macros.length) this.write(this.library); return before !== this.library.macros.length }
  setEnabled(id, enabled) { const macro = this.get(id); if (!macro) return null; return this.save({ ...macro, enabled: enabled === true }) }
  replaceAll(macros) { this.library = model.normalizeLibrary({ ...this.library, macros }); this.write(this.library); return this.library }
  write(library = this.library) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); const temporary = `${this.file}.tmp`; fs.writeFileSync(temporary, JSON.stringify(library, null, 2), 'utf8'); fs.renameSync(temporary, this.file) }
}
function writeBackV1(accountStore, macro, deleted = false) {
  const from = macro?.origin?.fromV1
  if (!from?.accountId) return false
  const v1 = deleted ? null : model.toV1(macro)
  if (!deleted && !v1) return false
  const updated = accountStore.updateAccount(from.accountId, (account) => {
    const automations = Array.isArray(account.automations) ? account.automations.slice() : []
    const id = from.automationId || macro.id
    const index = automations.findIndex((entry) => entry?.id === id)
    if (deleted) { if (index >= 0) automations.splice(index, 1) }
    else if (index >= 0) automations[index] = v1
    else automations.push(v1)
    return { ...account, automations }
  })
  return Boolean(updated)
}
module.exports = { MacroLibraryStore, writeBackV1 }
