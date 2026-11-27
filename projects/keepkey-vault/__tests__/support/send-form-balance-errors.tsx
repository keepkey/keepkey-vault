// KEEPKEY-177 (Audit v7 S11): an OSMO send whose amount fit the balance but not the
// fee only failed at build, with the builder's English text. The form now warns
// while the amount is typed, and shows the build error translated.
import { chainById, mount, unmount, setRecipient, setInput, click, lastBuild, text, settle } from './send-form-fixture'
import { balanceErrorMessage } from '../../src/shared/send-balance-errors'

const osmo = chainById('osmosis')
const owner = 'osmo1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3fxyjya'
const to = 'osmo1xvenxvenxvenxvenxvenxvenxvenxven59kfec'
const out: Record<string, unknown> = {}

// The fixture's t returns the key, so a warning shows as its key.
const warnings = () => ({
  withFee: /exceedsBalanceWithFee/.test(text()),
  overBalance: /exceedsBalance(?!WithFee)/.test(text()),
})

await mount({ chain: osmo, address: owner, balance: { chainId: 'osmosis', balance: '1', balanceUsd: 1, nativeBalanceUsd: 1, address: owner, syncState: 'confirmed' } })
await setRecipient(to)

// The default (average) fee is 0.015 OSMO.
await setInput('amountPlaceholder', '0.99')
out.overByFee = warnings()
await setInput('amountPlaceholder', '0.985')
out.exactlyBalance = warnings()
await setInput('amountPlaceholder', '0.5')
out.underBalance = warnings()
await setInput('amountPlaceholder', '2')
out.overBalance = warnings()

// A warning only: the build still runs, and its error comes back translated.
await setInput('amountPlaceholder', '0.99')
await click('buildTransaction')
const build = lastBuild()!
build.pending.reject(new Error(balanceErrorMessage('amountAndFee', { symbol: 'OSMO' })))
await settle()
out.buildError = /insufficientAmountAndFee/.test(text()) && !/Insufficient OSMO/.test(text())
await unmount()

console.log(JSON.stringify(out))
