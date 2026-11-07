import { expect, test } from 'bun:test'
import { retryOnTimeout } from '../src/mainview/lib/retry-on-timeout'

const timeout = (m = 'getRegisteredDevices') => new Error(`RPC request timed out: ${m}`)

test('a slow backend is retried with longer budgets, then answers', async () => {
  const budgets: number[] = [], slow: number[] = []
  const result = await retryOnTimeout(async ms => { budgets.push(ms); if (budgets.length < 3) throw timeout(); return 'ok' }, [5, 10, 20], n => slow.push(n))
  expect(result).toBe('ok'); expect(budgets).toEqual([5, 10, 20]); expect(slow).toEqual([1, 2])
})
test('a real error is not retried', async () => {
  let calls = 0
  await expect(retryOnTimeout(async () => { calls++; throw new Error('DB locked') }, [5, 10])).rejects.toThrow('DB locked')
  expect(calls).toBe(1)
})
test('after the last budget the timeout is reported', async () => {
  await expect(retryOnTimeout(async () => { throw timeout() }, [5, 10])).rejects.toThrow('timed out')
})
