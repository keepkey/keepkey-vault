import { describe, expect, test } from 'bun:test'
import { classifyNearIntentsStatus } from '../src/shared/near-intents-status'
import type { PendingSwap } from '../src/shared/types'
const sourceHash = '0x' + 'a'.repeat(64), payoutHash = 'b'.repeat(64)
const deposit = '0x2222222222222222222222222222222222222222', sender = '0x1111111111111111111111111111111111111111'
const recipient = 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9'
const swap = { txid: sourceHash, fromCaip: 'eip155:1/slip44:60', toCaip: 'bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2', fromAmount: '0.021319123456789123', expectedOutput: '0.89', minimumOutput: '0.86', status: 'pending', inboundAddress: deposit,
 trackingContext: { fromAddress: sender, toAddress: recipient, nearIntents: { depositAddress: deposit, refundTo: sender, originAsset: 'nep141:eth.omft.near', destinationAsset: 'nep141:ltc.omft.near', sourceDecimals: 18, destinationDecimals: 8 } } } as PendingSwap
const status = { status: 'SUCCESS', quoteResponse: { quoteRequest: { dry: false, swapType: 'EXACT_INPUT', depositMode: 'SIMPLE', depositType: 'ORIGIN_CHAIN', refundType: 'ORIGIN_CHAIN', refundTo: sender, recipientType: 'DESTINATION_CHAIN', recipient, originAsset: 'nep141:eth.omft.near', destinationAsset: 'nep141:ltc.omft.near', amount: '21319123456789123' }, quote: { depositAddress: deposit, amountIn: '21319123456789123', amountOut: '89000000', minAmountOut: '86000000' } }, swapDetails: { originChainTxHashes: [{ hash: sourceHash }], destinationChainTxHashes: [{ hash: payoutHash }], nearTxHashes: ['near-internal-transaction'], depositedAmount: '21319123456789123', amountOut: '87000000' } }
describe('NEAR settlement proof', () => {
 test('records actual destination amount and hash for exact 18-decimal input', () => { expect(classifyNearIntentsStatus(swap, status)).toMatchObject({ status: 'completed', outboundTxid: payoutHash, receivedOutput: '0.87' }) })
 test('waits for destination settlement rather than source confirmation', () => {
  for (const state of ['PENDING_DEPOSIT','KNOWN_DEPOSIT_TX','INCOMPLETE_DEPOSIT','PROCESSING']) { const b=structuredClone(status); b.status=state; b.swapDetails.destinationChainTxHashes=[]; expect(classifyNearIntentsStatus(swap,b).status).toBe(state==='PENDING_DEPOSIT'?'pending':'confirming') }
 })
 test('rejects substituted assets, amounts, addresses, refund types and payout proof', () => {
  for (const change of [
   (b:any)=>{b.quoteResponse.quoteRequest.refundTo=deposit}, (b:any)=>{b.quoteResponse.quoteRequest.refundType='INTENTS'},
   (b:any)=>{b.quoteResponse.quoteRequest.recipientType='INTENTS'}, (b:any)=>{b.quoteResponse.quoteRequest.recipient=sender},
   (b:any)=>{b.quoteResponse.quoteRequest.originAsset='nep141:base.omft.near'},(b:any)=>{b.quoteResponse.quoteRequest.destinationAsset='nep141:btc.omft.near'},
   (b:any)=>{b.quoteResponse.quoteRequest.amount='21319123456789124'},(b:any)=>{b.quoteResponse.quote.depositAddress=sender},
   (b:any)=>{b.quoteResponse.quote.depositMemo='tag-required'},(b:any)=>{b.quoteResponse.quote.minAmountOut='1'},
   (b:any)=>{b.swapDetails.originChainTxHashes=[]},(b:any)=>{b.swapDetails.originChainTxHashes=[{hash:'0x'+'c'.repeat(64)}]},
   (b:any)=>{b.swapDetails.destinationChainTxHashes=[]},(b:any)=>{b.swapDetails.destinationChainTxHashes=[{hash:'0'.repeat(64)}]},
   (b:any)=>{b.swapDetails.destinationChainTxHashes=[{hash:sourceHash}]},(b:any)=>{b.swapDetails.destinationChainTxHashes=[{hash:'unusable-id'}]},
   (b:any)=>{delete b.swapDetails.amountOut},(b:any)=>{b.swapDetails.amountOut='1'},(b:any)=>{b.swapDetails.depositedAmount='1'},
  ]) { const b=structuredClone(status); change(b); expect(()=>classifyNearIntentsStatus(swap,b)).toThrow() }
 })
 test('does not guess the wallet context on historical records',()=>{ expect(()=>classifyNearIntentsStatus({...swap,trackingContext:undefined},status)).toThrow('actual sender'); expect(()=>classifyNearIntentsStatus({...swap,trackingContext:{...swap.trackingContext!,fromAddress:deposit}},status)).toThrow() })
 test('requires a distinct source-chain refund and actual returned amount',()=>{
  const b:any=structuredClone(status); b.status='REFUNDED';b.swapDetails.destinationChainTxHashes=[];b.swapDetails.refundedAmount='21200000000000000';
  expect(()=>classifyNearIntentsStatus(swap,b)).toThrow();b.swapDetails.originChainTxHashes.push({hash:'0x'+'d'.repeat(64)});
  expect(classifyNearIntentsStatus(swap,b)).toMatchObject({status:'refunded',refundTxid:'0x'+'d'.repeat(64)})
 })
 test('preserves Solana source signature case',()=>{
  const s={...swap,txid:'A'.repeat(87),fromCaip:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501',fromAmount:'0.25',trackingContext:{fromAddress:'So11111111111111111111111111111111111111112',toAddress:recipient,nearIntents:{depositAddress:'Ebv2YHiH8aWSZpYgH6fAsEXoyWqfdLao9XX7K3E7ssGv'}}}; const b:any=structuredClone(status);
  Object.assign(b.quoteResponse.quoteRequest,{originAsset:'nep141:sol.omft.near',amount:'250000000',refundTo:s.trackingContext.fromAddress});Object.assign(b.quoteResponse.quote,{depositAddress:s.trackingContext.nearIntents.depositAddress,amountIn:'250000000'});Object.assign(b.swapDetails,{depositedAmount:'250000000',originChainTxHashes:[{hash:s.txid}]});
  expect(classifyNearIntentsStatus(s,b).status).toBe('completed');b.swapDetails.originChainTxHashes[0].hash=s.txid.toLowerCase();expect(()=>classifyNearIntentsStatus(s,b)).toThrow()
 })
})
