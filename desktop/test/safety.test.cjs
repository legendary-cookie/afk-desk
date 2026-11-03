'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
for (const file of ['../electron/safety.cjs', '../../mobile/nodejs-assets/nodejs-project/safety.cjs']) {
  const { shouldEat, pickFood, shouldLowHealthAct, isWithinSchedule } = require(file)
  test(`${file}: safety decisions`, () => {
    assert.equal(shouldEat({ autoEat: true }, { food: 14 }), true)
    assert.equal(shouldEat({ autoEat: true }, { food: 14, currentWindow: {} }), false)
    assert.equal(shouldEat({}, { food: 1 }), false)
    const items = [{ name: 'steak', slot: 9 }, { name: 'bread', slot: 36 }, { name: 'steak', slot: 37 }]
    const foods = { steak: { foodPoints: 8, saturation: 12 }, bread: { foodPoints: 5, saturation: 6 } }
    assert.equal(pickFood(items, foods, [37]).name, 'bread')
    assert.equal(pickFood(items, foods, [36, 37]).slot, 9)
    assert.equal(shouldLowHealthAct({ lowHealthTotem: true }, 6), true)
    assert.equal(shouldLowHealthAct({ lowHealthDisconnect: true }, 7), false)
    assert.equal(shouldLowHealthAct({}, 1), false)
    const schedule = { scheduleEnabled: true, scheduleStart: '22:00', scheduleEnd: '02:00', scheduleDays: [1] }
    assert.equal(isWithinSchedule(schedule, new Date(2026, 10, 2, 23)), true)
    assert.equal(isWithinSchedule(schedule, new Date(2026, 10, 3, 1)), true)
    assert.equal(isWithinSchedule(schedule, new Date(2026, 10, 3, 2)), false)
    assert.equal(isWithinSchedule(schedule, new Date(2026, 10, 3, 23)), false)
  })
}
