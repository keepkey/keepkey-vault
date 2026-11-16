// Jasper audit v5 V4: a QR label= never becomes the memo; XRP takes its tag from dt= only.
import { expect } from 'bun:test'
import { chainById, mount, unmount, input, scan } from './send-form-fixture'
const memoAfter = async (chainId: string, uri: string) => {
  await mount({ chain: chainById(chainId), address: null,
    balance: { chainId, balance: '100', balanceUsd: 0, nativeBalanceUsd: 0, address: 'x', syncState: 'confirmed' } })
  await scan(uri)
  const memo = input('memoPlaceholder').value
  await unmount()
  return memo
}
const xrp = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', atom = 'cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0eph6dd02'
const summary = {
  xrpLabel: await memoAfter('ripple', `xrp:${xrp}?label=Alice`),
  xrpTag: await memoAfter('ripple', `ripple:${xrp}?dt=104857&label=Alice`),
  xrpBareTag: await memoAfter('ripple', `${xrp}?dt=7`),
  xrpMemoIgnored: await memoAfter('ripple', `xrp:${xrp}?memo=hello`),
  cosmosLabel: await memoAfter('cosmos', `cosmos:${atom}?label=Alice`),
  cosmosMemo: await memoAfter('cosmos', `cosmos:${atom}?memo=12345&label=Alice`),
}
expect(summary).toEqual({ xrpLabel: '', xrpTag: '104857', xrpBareTag: '7', xrpMemoIgnored: '', cosmosLabel: '', cosmosMemo: '12345' })
console.log(JSON.stringify(summary))
