import { beforeAll, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { btcAddressIndexLimit, MAX_NEW_BTC_ADDRESSES } from '../src/mainview/lib/btc-receive'

let result: any
beforeAll(async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./support/btc-receive-selection.tsx', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), 25000)
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  if (code) throw new Error(err || out)
  result = JSON.parse(out.trim().split('\n').at(-1)!)
}, 30000)

test('an untouched BTC receive address still moves to the next unused one after a sync', () => {
  expect(result.opened).toEqual({ change: 0, index: 3, limit: 13 })
  expect(result.followingWhileSyncing).toEqual({ loading: true })
  expect(result.untouchedAfterSync).toEqual({ change: 0, index: 4, limit: 14 })
})

test('a balance sync keeps the BTC address the user stepped to (audit v6 U2)', () => {
  expect(result.pickedWhileSyncing).toEqual({ loading: false })
  expect(result.pickedAfterSync).toEqual({ change: 0, index: 7, limit: 15 })
})

test('the change branch follows its own next unused index until the user steps', () => {
  expect(result.changeBranch).toEqual({ change: 1, index: 1, limit: 11 })
  expect(result.changeAfterSync).toEqual({ change: 1, index: 2, limit: 12 })
  expect(result.steppedBack).toEqual({ change: 1, index: 2, limit: 12 })
})

test('another account starts over at its next unused receive address', () => {
  expect(result.otherAccount).toEqual({ change: 0, index: 9, limit: 19 })
})

test('the "+" limit is relative to the next unused index, so stepping back frees it', () => {
  expect(btcAddressIndexLimit({ receiveIndex: 3, changeIndex: 1 }, 0)).toBe(3 + MAX_NEW_BTC_ADDRESSES)
  expect(btcAddressIndexLimit({ receiveIndex: 3, changeIndex: 1 }, 1)).toBe(1 + MAX_NEW_BTC_ADDRESSES)
  expect(btcAddressIndexLimit(null, 0)).toBe(MAX_NEW_BTC_ADDRESSES)
})
