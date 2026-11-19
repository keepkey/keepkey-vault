import { beforeAll, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

let result: any
beforeAll(async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./support/receive-verify-error.tsx', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), 25000)
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  if (code) throw new Error(err || out)
  result = JSON.parse(out.trim().split('\n').at(-1)!)
}, 30000)

const NOT_CONFIRMED = 'The address was not confirmed.'

test('a failed "Verify on device" says the address was not confirmed (audit v6 U3)', () => {
  expect(result.verifying).toEqual({ alert: null, busy: true })
  expect(result.cancelled.alert).toBe(`Verification cancelled on your KeepKey. ${NOT_CONFIRMED}`)
  expect(result.noAnswer.alert).toBe(`No answer from your KeepKey. Check its screen, then try again. ${NOT_CONFIRMED}`)
  expect(result.deviceLost.alert).toBe(`Your KeepKey is not responding. Reconnect it and try again. ${NOT_CONFIRMED}`)
  expect(result.other.alert).toBe(`Could not show the address on your KeepKey (Failure_Other). ${NOT_CONFIRMED}`)
  expect(result.customHandler.alert).toBe(result.other.alert)
  expect(result.syncThrow).toEqual({ alert: result.other.alert, busy: false })
})

test('the error clears on retry, on success and when the address changes', () => {
  expect(result.retrying).toEqual({ alert: null, busy: true })
  expect(result.succeeded).toEqual({ alert: null, busy: false })
  expect(result.addressChanged).toEqual({ alert: null, busy: false })
  expect(result.backToFailedAddress).toEqual({ alert: null, busy: false })
  expect(result.rederived).toEqual({ alert: null, busy: false })
})

test('a failure for a previous address is not shown against the current one', () => {
  expect(result.staleReply).toEqual({ alert: null, busy: false })
})
