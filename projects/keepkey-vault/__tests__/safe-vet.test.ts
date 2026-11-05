import { describe, expect, test } from 'bun:test'
import { ethers } from 'ethers'
import fixture from './fixtures/safe/safedao-vet.json'
import { vetSafe } from '../src/bun/safe-core'

// Real eth_getCode/eth_call answers for the Safe DAO treasury (Safe 1.3.0,
// chain 1), which runs standard Safe code and has one module enabled.
const SAFE = fixture.safe
const SINGLETON = '0xd9db270c1b5e3bd161e8c8503c55ceabee709552'
const MODULE = '0x4ECeFC422c98a096eD8b56EaD67477c4B6e8702b'

function reader(overrides: Record<string, string> = {}) {
  const responses: Record<string, string> = { ...fixture.responses, ...overrides }
  return {
    getCode: async (a: string) => responses[`code:${a.toLowerCase()}`] ?? '0x',
    call: async (to: string, data: string) => {
      const hit = responses[`call:${to.toLowerCase()}:${data}`]
      if (!hit) throw new Error(`unrecorded call ${data.slice(0, 10)}`)
      return hit
    },
  }
}
const key = (selector: string) => Object.keys(fixture.responses).find(k => k.includes(`:${selector}`))!
const flipLastByte = (hex: string) => hex.slice(0, -2) + (hex.endsWith('00') ? '01' : '00')
const word = (address: string) => ethers.utils.defaultAbiCoder.encode(['bytes'], [ethers.utils.hexZeroPad(address, 32)])

describe("vetSafe checks the Safe runs Safe's own code and lists its extensions", () => {
  test('the real Safe DAO runs Safe code and has one module', async () => {
    const v = await vetSafe(1, SAFE, reader())
    expect(v.codeProblem).toBeNull()
    expect(v.extensions).toHaveLength(1)
    expect(v.extensions[0]).toStartWith(`Module ${MODULE} can make transactions`)
  })

  test('with no module it is fully standard', async () => {
    const empty = ethers.utils.defaultAbiCoder.encode(['address[]', 'address'], [[], '0x0000000000000000000000000000000000000001'])
    expect(await vetSafe(1, SAFE, reader({ [key('0xcc2f8452')]: empty }))).toEqual({ codeProblem: null, extensions: [] })
  })

  test('one changed byte of proxy code is not a Safe', async () => {
    const code = `code:${SAFE.toLowerCase()}`
    expect(await vetSafe(1, SAFE, reader({ [code]: flipLastByte(fixture.responses[code as keyof typeof fixture.responses]) })))
      .toEqual({ codeProblem: 'Its contract is not a standard Safe proxy', extensions: [] })
  })

  test('one changed byte of singleton code fails', async () => {
    const code = `code:${SINGLETON}`
    const v = await vetSafe(1, SAFE, reader({ [code]: flipLastByte(fixture.responses[code as keyof typeof fixture.responses]) }))
    expect(v.codeProblem).toContain("does not match Safe's published build")
  })

  test('a proxy pointing at unknown code, or on a chain without that deployment, fails', async () => {
    const other = '0x1111111111111111111111111111111111111111'
    expect((await vetSafe(1, SAFE, reader({ [key('0xa619486e')]: ethers.utils.hexZeroPad(other, 32) }))).codeProblem).toContain('does not recognize')
    expect((await vetSafe(2868, SAFE, reader())).codeProblem).toContain('does not recognize')
  })

  test('a guard and a custom fallback handler are described, not treated as problems', async () => {
    const odd = '0x2222222222222222222222222222222222222222'
    const guardKey = Object.keys(fixture.responses).find(k => k.includes(':0x5624b25b4a204f62'))!
    const handlerKey = Object.keys(fixture.responses).find(k => k.includes(':0x5624b25b6c9a6c4a'))!
    const v = await vetSafe(1, SAFE, reader({ [guardKey]: word(odd), [handlerKey]: word(odd) }))
    expect(v.codeProblem).toBeNull()
    expect(v.extensions.some(e => e.startsWith(`Guard ${odd}`))).toBe(true)
    expect(v.extensions.some(e => e.startsWith(`Custom fallback handler ${odd}`))).toBe(true)
  })
})
