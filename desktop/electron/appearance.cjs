'use strict'
const { Authflow, Titles } = require('prismarine-auth')
const { profilePath } = require('./profile-path.cjs')

function normalizeChange(input) {
  const skin = input?.skin
  let normalizedSkin = null
  if (skin) {
    if (!['classic', 'slim'].includes(skin.variant)) throw new Error('Choose a classic or slim skin.')
    if (skin.url) {
      let url
      try { url = new URL(skin.url) } catch { throw new Error('Enter a valid HTTPS skin URL.') }
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Enter a valid HTTPS skin URL.')
      normalizedSkin = { variant: skin.variant, url: url.href }
    } else if (typeof skin.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(skin.data) && skin.data.length <= 1400000) {
      const bytes = Buffer.from(skin.data, 'base64')
      if (bytes.length > 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('Choose a PNG skin under 1 MB.')
      normalizedSkin = { variant: skin.variant, data: bytes }
    } else throw new Error('Choose a PNG skin or enter a skin URL.')
  }
  const cape = input?.cape
  if (cape != null && (typeof cape !== 'string' || !/^[a-f0-9-]{36}$/i.test(cape))) throw new Error('Enter a valid cape ID.')
  if (!normalizedSkin && !cape) throw new Error('Choose a skin and/or cape.')
  return { skin: normalizedSkin, cape: cape || null }
}

async function changeAccount(account, change, { profilesPath, fetch = globalThis.fetch, getToken } = {}) {
  const token = getToken ? await getToken(account) : (await new Authflow(account.username, profilePath(profilesPath, account.identityId || account.id), { flow: 'live', authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo' }, () => { throw new Error('Sign in to this account before changing its appearance.') }).getMinecraftJavaToken()).token
  const outcomes = []
  for (const kind of ['skin', 'cape']) {
    if (!change[kind]) continue
    try {
      let body, headers = { authorization: `Bearer ${token}` }
      if (kind === 'skin' && change.skin.data) {
        body = new FormData()
        body.set('variant', change.skin.variant)
        body.set('file', new Blob([change.skin.data], { type: 'image/png' }), 'skin.png')
      } else {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(kind === 'skin' ? change.skin : { capeId: change.cape })
      }
      const response = await fetch(`https://api.minecraftservices.com/minecraft/profile/${kind === 'skin' ? 'skins' : 'capes/active'}`, { method: kind === 'skin' ? 'POST' : 'PUT', headers, body, redirect: 'error' })
      if (!response.ok) throw new Error(`Minecraft service returned ${response.status}.`)
      outcomes.push(`${kind}: applied`)
    } catch (error) { outcomes.push(`${kind}: ${error.message}`) }
  }
  return outcomes.join('; ')
}

async function bulkChange(accounts, ids, input, options = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string')) throw new Error('Select accounts to update.')
  const change = normalizeChange(input)
  const results = []
  let attempted = false
  for (const id of [...new Set(ids)]) {
    const account = accounts.find(a => a.id === id)
    if (!account) { results.push({ id, status: 'skipped', message: 'Account not found.' }); continue }
    if (account.edition === 'bedrock' || (account.auth && account.auth !== 'microsoft') || account.offline === true) { results.push({ id, status: 'skipped', message: 'Only premium Java Microsoft accounts are supported.' }); continue }
    if (attempted) await (options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms))))(500)
    attempted = true
    try {
      const message = await (options.changeAccount || changeAccount)(account, change, options)
      results.push({ id, status: message.includes(': applied') && !/:(?! applied)/.test(message) ? 'success' : 'failed', message })
    } catch (error) { results.push({ id, status: 'failed', message: String(error?.message || 'Appearance update failed.').slice(0, 250) }) }
  }
  return results
}
module.exports = { normalizeChange, changeAccount, bulkChange }
