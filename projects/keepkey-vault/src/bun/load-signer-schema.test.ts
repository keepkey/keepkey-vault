import { describe, expect, test } from 'bun:test'
import { LoadClearsignSignerRequest } from './schemas'

const body = { keyId: 1, pubkey: `02${'11'.repeat(32)}`, alias: 'Acme Labs' }

describe('POST /eth/clearsign/load-signer schema', () => {
  test('persist:true is refused with a clear reason (signers are RAM-only)', () => {
    const r = LoadClearsignSignerRequest.safeParse({ ...body, persist: true })
    expect(r.success).toBe(false)
    expect(r.error!.issues[0]).toMatchObject({ path: ['persist'] })
    expect(r.error!.issues[0].message).toContain('RAM-only')
  })

  test('the same body without persist parses, and the parsed body never carries persist', () => {
    expect(LoadClearsignSignerRequest.parse(body)).toEqual(body)
    expect('persist' in LoadClearsignSignerRequest.parse({ ...body, persist: false })).toBe(false)
  })

  test('the icon rule still holds', () => {
    expect(LoadClearsignSignerRequest.safeParse({ ...body, icon: 'ab' }).success).toBe(false)
  })
})
