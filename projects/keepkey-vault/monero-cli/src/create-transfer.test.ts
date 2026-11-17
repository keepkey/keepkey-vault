import { expect, test } from 'bun:test'
import { RpcFailure } from './digest'
import { PublicError } from './protocol'
import { MoneroWatchService } from './wallet'

const ADDRESS = '44jKQv6ZKMd5ecLLmkNJGi7azgSptEq8ki7TFiat1TfLfdDQ1tQ7ZYa3cRh7X2uRwvLDjddWh97ajeyhR2seKSECQeDx1WR'

for (const code of [-17, -37]) {
  test(`Core insufficient-funds error ${code} preserves the fee-budget diagnostic and does not continue preparation`, async () => {
    const service = new MoneroWatchService('/unused-wallet-rpc', '/unused-adapter')
    const calls: string[] = []
    ;(service as any).session = { sendable: true, rpc: { call: async (method: string) => {
      calls.push(method)
      throw new RpcFailure(code)
    } } }
    let failure: unknown
    try { await service.createTransfer({ address: ADDRESS, amountAtomic: '1', priority: 0 }) }
    catch (error) { failure = error }
    expect(failure).toBeInstanceOf(PublicError)
    expect((failure as Error).message).toBe('Not enough unlocked XMR for this amount and fee')
    expect(calls).toEqual(['transfer'])
  })
}

test('other Core transfer failures cannot masquerade as insufficient funds', async () => {
  const service = new MoneroWatchService('/unused-wallet-rpc', '/unused-adapter')
  ;(service as any).session = { sendable: true, rpc: { call: async () => { throw new RpcFailure(-4) } } }
  await expect(service.createTransfer({ address: ADDRESS, amountAtomic: '1', priority: 0 }))
    .rejects.toThrow('The watch wallet cannot build this transaction')
})
