// KEEPKEY-126: the review amount is exactly what the KeepKey prints (to compare with
// the OLED); below it, rounded like the balance. KEEPKEY-76: TON max shows what was built.
import { expect } from 'bun:test'
import { chainById, mount, unmount, setRecipient, setInput, click, lastBuild, complete, query } from './send-form-fixture'
const out: Record<string, unknown> = {}
const shown = () => ({ main: query('[data-send-review-amount]')?.textContent?.trim(), approx: query('[data-send-review-approx]')?.textContent?.trim() })

await mount({ chain: chainById('ton'), address: 'UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI',
  balance: { chainId: 'ton', balance: '1.25', balanceUsd: 5, nativeBalanceUsd: 5, address: 'x', syncState: 'confirmed' } })
await setRecipient('EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N')
await click('max'); await click('buildTransaction')
expect(lastBuild()!.params).toMatchObject({ isMax: true, amount: '0' })
await complete(lastBuild()!, { fee: '0.005', unsignedTx: { amount: '1245000000' } })
out.tonMax = shown().main === '1.245 TON'
await unmount()

await mount({ chain: chainById('bitcoin'), address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  balance: { chainId: 'bitcoin', balance: '1', balanceUsd: 100, nativeBalanceUsd: 100, address: 'x', syncState: 'confirmed' } })
await setRecipient('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
await setInput('amountPlaceholder', '0.12345678')
await click('buildTransaction')
await complete(lastBuild()!, { fee: '0.00001', unsignedTx: { outputs: [] } })
out.btcDevice = shown().main === '0.12345678 BTC'
out.btcApprox = shown().approx?.startsWith('≈ 0.12345678 BTC') // the fixture's formatBalance is String
await unmount()

await mount({ chain: chainById('base'), address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  balance: { chainId: 'base', balance: '0.12', balanceUsd: 100, nativeBalanceUsd: 100, address: 'x', syncState: 'confirmed' } })
await setRecipient('0x1111111254EEB25477B68fb85Ed929f73A960582')
await click('max'); await click('buildTransaction')
await complete(lastBuild()!, { fee: '0.0000013', unsignedTx: { value: '0x' + (119_948_700_000_000_001n).toString(16) } })
out.ethAll18 = shown().main === '0.119948700000000001 ETH'
await unmount()
console.log(JSON.stringify(out))
