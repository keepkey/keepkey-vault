import { expect, test } from 'bun:test'
import { singleFlight } from './single-flight'

// V12: the same signed tx broadcast twice while the first call is in flight
// goes out once; both callers get that one result.
test('an identical in-flight call is joined, not repeated', async () => {
  const run = singleFlight<string>()
  let calls = 0
  let release!: (v: string) => void
  const work = () => { calls++; return new Promise<string>(r => { release = r }) }
  const a = run('signed-tx', work)
  const b = run('signed-tx', work)
  release('0xtxid')
  expect(await a).toBe('0xtxid')
  expect(await b).toBe('0xtxid')
  expect(calls).toBe(1)
})

test('after it settles (or fails), the same key runs again', async () => {
  const run = singleFlight<string>()
  let calls = 0
  await expect(run('k', async () => { calls++; throw new Error('rejected') })).rejects.toThrow('rejected')
  expect(await run('k', async () => { calls++; return 'ok' })).toBe('ok')
  expect(await run('other', async () => { calls++; return 'ok2' })).toBe('ok2')
  expect(calls).toBe(3)
})
