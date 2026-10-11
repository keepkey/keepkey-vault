import { expect, test } from 'bun:test'
import { deviceRefusalText, takeDeviceRefusal } from './device-refusal'

const at = 1000

test('a policy refusal keeps the device text', () => {
  expect(deviceRefusalText({ code: 4, message: 'Arbitrary contract data signing disabled by policy', at }, at))
    .toBe('Arbitrary contract data signing disabled by policy')
})

test('a button reject is still a user cancel', () => {
  expect(deviceRefusalText({ code: 4, message: 'Signing cancelled by user', at }, at)).toBeNull()
  expect(deviceRefusalText({ code: 4, message: 'EIP-712 cancelled', at }, at)).toBeNull()
  expect(deviceRefusalText({ code: 4, message: 'Aborted', at }, at)).toBeNull()
})

test('a failure from an earlier request, another code, or no text is ignored', () => {
  expect(deviceRefusalText({ code: 4, message: 'AdvancedMode required for clearsign metadata', at: at - 1 }, at)).toBeNull()
  expect(deviceRefusalText({ code: 9, message: 'Invalid denom', at }, at)).toBeNull()
  expect(deviceRefusalText({ code: 4, at }, at)).toBeNull()
  expect(deviceRefusalText(null, at)).toBeNull()
})

test('a refusal is reported once, to the first request that reads it', () => {
  const engine = { lastFailure: { code: 4, message: 'Arbitrary contract data signing disabled by policy', at } }
  expect(takeDeviceRefusal(engine, at)).toBe('Arbitrary contract data signing disabled by policy')
  expect(takeDeviceRefusal(engine, at)).toBeNull()
})
