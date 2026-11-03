function maskNames(text, accounts, enabled) {
  if (!enabled || !text) return text
  const names = accounts.flatMap((account, index) => [account.username, account.minecraftName].filter(Boolean).map(name => ({name, label: `Account ${index + 1}`})))
    .sort ( (a, b) => b.name.length - a.name.length )
  if (!names.length) return text
  const labels = new Map(names.map(({name, label}) => [name.toLowerCase(), label]))
  const pattern = new RegExp(names.map(({name}) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')
  return String(text).replace(pattern, match => labels.get(match.toLowerCase()))
}
function addRecent(history, message) {
  return [message, ...history.filter(item => item !== message)].slice(0, 20)
}
module.exports = {maskNames, addRecent}
