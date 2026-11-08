import { expect, test } from 'bun:test'
import { passwordDeviceCipher } from '../src/bun/password-device'
import { PasswordBank, PASSWORD_BANK_SETTING } from '../src/bun/password-bank'

function fixture() {
  const db = new Map<string, string>()
  const prompts: { label: string; decide: (approved: boolean) => void }[] = []
  let writes = 0
  const wallet = { cipherKeyValue: async (params: any) => {
    writes++
    expect(params.askOnEncrypt).toBe(true); expect(params.askOnDecrypt).toBe(true)
    expect(params.value).toEqual(new Uint8Array(32)); expect(params.iv).toEqual(new Uint8Array(16))
    return new Uint8Array(32).fill(42)
  } }
  const confirm: Parameters<typeof passwordDeviceCipher>[4] = async (operation, details) => {
    const result = operation()
    const approved = await new Promise<boolean>(decide => prompts.push({ label: details.opLabel, decide }))
    if (!approved) throw new Error('User rejected emulator approval')
    return result
  }
  const bank = new PasswordBank({ read: key => db.get(key) ?? null, write: (key, value) => { db.set(key, value) },
    device: () => ({ session: 'disposable-test', cipher: (path, key) => passwordDeviceCipher(wallet, path, key, true, confirm) }) })
  bank.setEnabled(true)
  return { bank, db, prompts, wallet, confirm, writes: () => writes }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('emulator bank creation waits for explicit approval and cancellation leaves no bank', async () => {
  const f = fixture()
  const pending = f.bank.unlock(true)
  await tick()
  expect(f.prompts).toHaveLength(1)
  expect(f.prompts[0].label).toBe('Unlock password bank')
  expect(f.db.has(PASSWORD_BANK_SETTING)).toBe(false)
  f.prompts[0].decide(false)
  await expect(pending).rejects.toThrow('User rejected')
  expect(f.bank.view().exists).toBe(false)
  expect(f.bank.view().unlocked).toBe(false)
  const retry = f.bank.unlock(true); await tick(); f.prompts[1].decide(true); await retry
  expect(f.bank.view().unlocked).toBe(true)
})

test('each generated emulator entry needs its own approval; disabling during approval discards the result', async () => {
  const f = fixture()
  const unlock = f.bank.unlock(true); await tick(); f.prompts[0].decide(true); await unlock
  const generate = f.bank.generate(2, 1)
  await tick(); expect(f.prompts).toHaveLength(2)
  expect(f.prompts[1].label).toBe('Derive password entry')
  f.prompts[1].decide(true); await tick(); expect(f.prompts).toHaveLength(3)
  f.prompts[2].decide(true); await generate
  expect(f.bank.view().readySlots).toHaveLength(2)
  const more = f.bank.generate(1, 1); await tick()
  f.bank.setEnabled(false); f.prompts[3].decide(true)
  await expect(more).rejects.toThrow()
  expect(f.bank.view().unlocked).toBe(false)
  expect(f.bank.view().readySlots).toEqual([])
})

test('physical device cipher uses firmware approval without opening an emulator prompt', async () => {
  const f = fixture()
  const result = await passwordDeviceCipher(f.wallet, [1], 'hardware test unlock', false, f.confirm)
  expect(result).toHaveLength(32)
  expect(f.writes()).toBe(1)
  expect(f.prompts).toEqual([])
})
