import { expect, test } from 'bun:test'
import { createPioneerServerSwitch } from '../src/bun/pioneer-server-switch'

const official = 'https://api.keepkey.info'
function setup() {
  let value = 'https://oracles.cc'
  const calls: string[] = []
  const deps = { defaultBase: official, getBase: () => value || official,
    save: (url: string) => { calls.push('save'); value = url },
    begin: () => { calls.push('stop old streams') }, retire: async () => { calls.push('disable old monitoring') },
    reset: async () => { calls.push('reset clients and caches') }, end: () => { calls.push(`resume:${value || official}`) } }
  return { deps, calls, change: createPioneerServerSwitch(deps), value: () => value }
}
test('clearing a test selection retires old monitoring before resuming the official server', async () => {
  const h = setup(); await h.change('')
  expect(h.value()).toBe('')
  expect(h.calls).toEqual(['stop old streams', 'disable old monitoring', 'save', 'reset clients and caches', `resume:${official}`])
})
test('choosing the official server stores the same default as clearing a selection', async () => {
  const h = setup(); await h.change(` ${official}/ `)
  expect(h.value()).toBe(''); expect(h.deps.getBase()).toBe(official)
})
test('failed cleanup preserves the old setting and resumes its streams for retry', async () => {
  const h = setup(); h.deps.retire = async () => { throw new Error('monitor unreachable') }
  await expect(h.change(official)).rejects.toThrow('monitor unreachable')
  expect(h.value()).toBe('https://oracles.cc')
  expect(h.calls).toEqual(['stop old streams', 'resume:https://oracles.cc'])
})
test('overlapping selections cannot interleave cleanup and settings writes', async () => {
  const h = setup(); let release!: () => void
  h.deps.retire = () => new Promise<void>(resolve => { release = resolve })
  const first = h.change(official)
  await expect(h.change('https://another.example')).rejects.toThrow('already in progress')
  release(); await first
  expect(h.deps.getBase()).toBe(official)
})
test('an unchanged normalized selection does not tear down its connection', async () => {
  const h = setup(); await h.change(' https://oracles.cc/// ')
  expect(h.calls).toEqual(['save'])
})
test('a rejected settings write never resets clients for a falsely reported selection', async () => {
  const h = setup(); h.deps.save = () => {}
  await expect(h.change('')).rejects.toThrow('could not be saved')
  expect(h.calls).not.toContain('reset clients and caches')
  expect(h.calls.at(-1)).toBe('resume:https://oracles.cc')
})
test('invalid URLs cannot be persisted before validation', async () => {
  const h = setup(); await expect(h.change('https://')).rejects.toThrow('valid API server URL')
  expect(h.calls).toEqual([]); expect(h.value()).toBe('https://oracles.cc')
})
