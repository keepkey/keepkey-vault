/**
 * Unit test for THORChain bank-token (TCY/RUJI) MsgSend denom threading.
 *
 * Verifies buildCosmosTx emits the token denom (not the chain native) when the
 * caip carries a `/bank:<denom>` segment, while RUNE sends stay native. No
 * device/Pioneer needed — Pioneer is stubbed. Run: bun src/bun/txbuilder/cosmos.test.ts
 */
import { buildCosmosTx } from './cosmos'

const THOR = {
  id: 'thorchain', coin: 'THORChain', symbol: 'RUNE',
  caip: 'cosmos:thorchain-mainnet-v1/slip44:931',
  decimals: 8, denom: 'rune', chainId: 'thorchain-1',
  defaultPath: [0x8000002c, 0x800003a3, 0x80000000, 0, 0],
} as any

const pioneer = {
  GetAccountInfo: async () => ({ data: { account: { account_number: '17', sequence: '2' } } }),
  GetPortfolioBalances: async () => ({ data: { balances: [{ balance: '100' }] } }),
}
const FROM = 'thor1g9el7lzjwh9yun2c4jjzhy09j98vkhfxfhgnzx'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (got === want) { console.log(`  ✅ ${label}`); pass++ }
  else { console.error(`  ❌ ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++ }
}
const sendMsg = (r: any) => r.tx.msg[0]

async function main() {
  // Native RUNE — denom must stay "rune", type MsgSend, 1.5 → 150000000
  const rune = await buildCosmosTx(pioneer, THOR, { to: FROM, amount: '1.5', fromAddress: FROM })
  eq('RUNE denom stays native', sendMsg(rune).value.amount[0].denom, 'rune')
  eq('RUNE amount base units', sendMsg(rune).value.amount[0].amount, '150000000')

  // TCY — denom from caip, fee still rune
  const tcy = await buildCosmosTx(pioneer, THOR, { to: FROM, amount: '2', fromAddress: FROM, caip: 'cosmos:thorchain-mainnet-v1/bank:tcy' })
  eq('TCY denom from caip', sendMsg(tcy).value.amount[0].denom, 'tcy')
  eq('TCY msg type is MsgSend', sendMsg(tcy).type, 'thorchain/MsgSend')
  eq('TCY fee paid in rune', tcy.tx.fee.amount[0].denom, 'rune')

  // RUJI — denom contains '/', must survive greedy parse
  const ruji = await buildCosmosTx(pioneer, THOR, { to: FROM, amount: '1', fromAddress: FROM, caip: 'cosmos:thorchain-mainnet-v1/bank:x/ruji' })
  eq('RUJI denom keeps slash', sendMsg(ruji).value.amount[0].denom, 'x/ruji')

  // Token MAX — sends full token balance, NO rune fee reserve subtracted
  const max = await buildCosmosTx(pioneer, THOR, { to: FROM, amount: '0', isMax: true, fromAddress: FROM, caip: 'cosmos:thorchain-mainnet-v1/bank:tcy', tokenBalance: '42.5', tokenDecimals: 8 })
  eq('TCY MAX = full balance, no fee reserve', sendMsg(max).value.amount[0].amount, '4250000000')

  console.log(`\n  Result: ${pass} passed, ${fail} failed\n`)
  process.exit(fail > 0 ? 1 : 0)
}
main().catch((e) => { console.error('crashed:', e); process.exit(1) })
