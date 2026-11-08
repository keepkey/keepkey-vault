import { expect, test } from 'bun:test'
import { createEmulatorSeedBackup } from './emulator-seed-backup'

// Published BIP39 test vector only. No real emulator, hardware or Keychain.
const PUBLIC_WORDS = [...Array(11).fill('abandon'), 'about'].join(' ')
function fixture() {
  let session: { wallet: object; delegate: object; instance: number; flashName: string } | null =
    { wallet: {}, delegate: {}, instance: 1, flashName: 'public-test-wallet' }
  let reads = 0, displays = 0
  let read = async (): Promise<string | null> => PUBLIC_WORDS
  let display = async (words: string, name: string) => { expect(words).toBe(PUBLIC_WORDS); expect(name).toBe('public-test-wallet') }
  const backup = createEmulatorSeedBackup({ session: () => session, readTimeoutMs: 20,
    readLive: () => { reads++; return read() }, display: async (...args) => { displays++; await display(...args) } })
  return { backup, counts: () => ({ reads, displays }), session: () => session,
    setSession: (next: typeof session) => { session = next }, setRead: (next: typeof read) => { read = next },
    setDisplay: (next: typeof display) => { display = next } }
}

test('the backup is displayed locally; the RPC result contains no recovery words', async () => {
  const f = fixture()
  expect(await f.backup()).toEqual({ seedDisplayed: true, flashName: 'public-test-wallet' })
  expect(f.counts()).toEqual({ reads: 1, displays: 1 })
})
test('no permitted emulator session means no seed read or display', async () => {
  const f = fixture(); f.setSession(null)
  await expect(f.backup()).rejects.toThrow('Unlock and connect the emulator')
  expect(f.counts()).toEqual({ reads: 0, displays: 0 })
})
test('invalid or missing live words cannot be replaced with a stale saved backup', async () => {
  for (const value of [null, '', 'invalid phrase']) {
    const f = fixture(); f.setRead(async () => value)
    await expect(f.backup()).rejects.toThrow('valid recovery phrase')
    expect(f.counts().displays).toBe(0)
  }
})
test('every emulator identity change during the read refuses display', async () => {
  for (const changed of [{ wallet: {} }, { delegate: {} }, { instance: 2 }, { flashName: 'another-wallet' }]) {
    const f = fixture()
    f.setRead(async () => { f.setSession({ ...f.session()!, ...changed }); return PUBLIC_WORDS })
    await expect(f.backup()).rejects.toThrow('wallet changed')
    expect(f.counts().displays).toBe(0)
  }
})
test('a stuck read is bounded and its late result cannot display words', async () => {
  const f = fixture(); let finish!: (value: string) => void
  f.setRead(() => new Promise(resolve => { finish = resolve }))
  await expect(f.backup()).rejects.toThrow('Unable to read')
  finish(PUBLIC_WORDS); await Promise.resolve()
  expect(f.counts().displays).toBe(0)
  f.setRead(async () => PUBLIC_WORDS)
  expect((await f.backup()).seedDisplayed).toBe(true)
})
test('concurrent backup requests cannot replace the displayed phrase', async () => {
  const f = fixture(); let finish!: () => void
  f.setDisplay(async () => { await new Promise<void>(resolve => { finish = resolve }) })
  const first = f.backup(); await Promise.resolve(); await Promise.resolve()
  await expect(f.backup()).rejects.toThrow('already open')
  finish(); await first
  expect(f.counts().displays).toBe(1)
})
test('private exception messages from a read or display never leave the backup handler', async () => {
  const f = fixture(); f.setRead(async () => { throw new Error('PRIVATE-PAYLOAD') })
  await expect(f.backup()).rejects.toThrow('Unable to read the emulator recovery phrase')
  f.setRead(async () => PUBLIC_WORDS); f.setDisplay(async () => { throw new Error('PRIVATE-PAYLOAD') })
  await expect(f.backup()).rejects.toThrow('The emulator window closed or could not display the recovery phrase')
})
