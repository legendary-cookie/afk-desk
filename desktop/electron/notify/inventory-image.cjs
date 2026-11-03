'use strict'
// Java inventory slots 9–44 comprise the main inventory and hotbar; 5–8 and 45 are equipment.
function inventoryLayout(items) {
  const list = Array.isArray(items) ? items : []
  const bySlot = new Map(list.filter(Boolean).map((item, index) => [Number.isInteger(item.slot) ? item.slot : index, item]))
  return [...Array.from({ length: 36 }, (_, i) => i + 9), 5, 6, 7, 8, 45].map((slot, i) => {
    const item = bySlot.get(slot)
    return { slot, x: i < 36 ? i % 9 : i - 36, y: i < 36 ? Math.floor(i / 9) : 4, name: String(item?.displayName || item?.name || '').slice(0, 32), count: Number(item?.count) || 0 }
  })
}
module.exports = { inventoryLayout }
