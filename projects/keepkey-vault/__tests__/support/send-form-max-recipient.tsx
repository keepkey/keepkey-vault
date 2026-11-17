// Jasper audit v5 V5: MAX review reads the sent amount even when the pasted recipient
// has surrounding whitespace, so the fee check runs.
import { expect } from 'bun:test'
import { chainById, mount, unmount, setRecipient, click, lastBuild, complete, text } from './send-form-fixture'
const to = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
await mount({ chain: chainById('bitcoin'), address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  balance: { chainId: 'bitcoin', balance: '0.001', balanceUsd: 100, nativeBalanceUsd: 100, address: 'x', syncState: 'confirmed' } })
await setRecipient(`${to} `)
await click('max'); await click('buildTransaction')
expect(lastBuild()!.params).toMatchObject({ to, isMax: true })
// The builder's outputs carry the trimmed address; the fee is half of what is sent.
await complete(lastBuild()!, { fee: '0.0005', unsignedTx: { outputs: [{ addressType: 'spend', address: to, amount: '50000' }] } })
const summary = { reviewAmount: text().includes('0.00050000 BTC'), maxPlaceholder: text().includes('MAX BTC'), feeWarning: text().includes('feeOverQuarter') }
expect(summary).toEqual({ reviewAmount: true, maxPlaceholder: false, feeWarning: true })
await unmount()
// Equivalent, checksum-valid bech32 casing and surrounding whitespace still
// identify the same output, whose atomic amount must never pass through Number.
await mount({ chain: chainById('bitcoin'), address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  balance: { chainId: 'bitcoin', balance: '100000000', balanceUsd: 100, nativeBalanceUsd: 100, address: 'x', syncState: 'confirmed' } })
await setRecipient(` ${to.toUpperCase()} `)
await click('max'); await click('buildTransaction')
await complete(lastBuild()!, { fee: '1', unsignedTx: { outputs: [{ addressType: 'spend', address: to, amount: '9007199254740993' }] } })
expect(text()).toContain('90071992.54740993 BTC')
await unmount()
console.log(JSON.stringify(summary))
