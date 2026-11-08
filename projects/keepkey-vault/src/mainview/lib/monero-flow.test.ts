import { describe, expect, test } from 'bun:test'
import { openMoneroWallet, prepareMoneroSend, verifyMoneroBalance } from './monero-flow'
import type { MoneroClient } from './monero-client'
import type { MoneroStatus } from '../../shared/types'
const wallet = (over: Partial<MoneroStatus> = {}): MoneroStatus => ({ available: true, network: 'mainnet', address: 'wallet-A',
 balanceAtomic: '1000000000000', unlockedBalanceAtomic: '1000000000000', walletHeight: 3000000, transactions: [], monitorReady: true,
 syncState: 'ready', canSend: true, spendStateKnown: true, keyImagesSynced: true, ...over })
function deferred<T>() { let resolve!: (x:T)=>void; let reject!: (e:unknown)=>void; const promise = new Promise<T>((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject} }
function client() {
 const calls: string[] = []
 const api = { connect: async () => { calls.push('connect'); return wallet() },
 syncKeyImages: async () => { calls.push('sync'); return wallet() },
 prepareSend: async () => { calls.push('prepare'); return { prepareId: 'a'.repeat(32) } },
 send: async () => { calls.push('send'); throw new Error('Signing must require a separate user approval') } } as unknown as MoneroClient
 return { api, calls }
}
const payment = {address:'recipient',amountAtomic:'1000000000'}
describe('automatic Monero setup', () => {
 test('Receive/Send share a single consent request already in flight', async () => {
  const {api,calls}=client(); const pending=deferred<MoneroStatus>()
  api.connect=async()=>{calls.push('connect');return pending.promise}
  const one=openMoneroWallet(api,0),two=openMoneroWallet(api,0)
  expect(one).toBe(two);expect(calls).toEqual(['connect'])
  pending.resolve(wallet());await one
 })
 test('a declined consent stops, and an explicit retry can start a fresh request', async()=>{
  const {api,calls}=client();let fail=true
  api.connect=async()=>{calls.push('connect');if(fail)throw new Error('Declined');return wallet()}
  await expect(openMoneroWallet(api,0)).rejects.toThrow('Declined')
  await Bun.sleep(1);expect(calls).toEqual(['connect']);fail=false
  await openMoneroWallet(api,0);expect(calls).toEqual(['connect','connect'])
 })
})
describe('Review send performs required verification',()=>{
 test('a fresh wallet prepares directly without another device prompt or signing',async()=>{
  const {api,calls}=client()
  await prepareMoneroSend(api,wallet(),payment,()=>{},()=>{calls.push('verifying')})
  expect(calls).toEqual(['prepare'])
 })
 test('missing or stale key images are verified before preparation',async()=>{
  for(const over of [{keyImagesSynced:false,sendBlocked:'key-images' as const},{keyImagesStale:true}]){
   const {api,calls}=client()
   await prepareMoneroSend(api,wallet(over),payment,()=>{calls.push('status')},()=>{calls.push('verifying')})
   expect(calls).toEqual(['verifying','sync','status','prepare'])
  }
 })
 test('declining verification never prepares or signs a transaction',async()=>{
  const {api,calls}=client();api.syncKeyImages=async()=>{calls.push('declined');throw new Error('Declined')}
  await expect(prepareMoneroSend(api,wallet({keyImagesStale:true}),payment,()=>{},()=>{})).rejects.toThrow('Declined')
  expect(calls).toEqual(['declined'])
 })
 test('a changed wallet or a pending broadcast returned by verification cannot prepare',async()=>{
  for(const status of [wallet({address:'wallet-B'}),wallet({available:false}),wallet({unrelayedTxid:'pending'}),wallet({canSend:false})]){
   const {api,calls}=client();api.syncKeyImages=async()=>status
   await expect(prepareMoneroSend(api,wallet({keyImagesStale:true}),payment,()=>{},()=>{})).rejects.toThrow()
   expect(calls).toEqual([])
  }
 })
 test('a pending broadcast blocks the entire pipeline',async()=>{
  const {api,calls}=client()
  await expect(prepareMoneroSend(api,wallet({unrelayedTxid:'pending',keyImagesStale:true}),payment,()=>{},()=>{})).rejects.toThrow('previous transaction')
  expect(calls).toEqual([])
 })
})


test('opening XMR and reviewing a send share balance verification already in progress', async () => {
 const {api,calls}=client(), pending=deferred<MoneroStatus>()
 api.syncKeyImages=async()=>{calls.push('sync');return pending.promise}
 const opening=verifyMoneroBalance(api)
 const preparing=prepareMoneroSend(api,wallet({keyImagesSynced:false}),payment,()=>{},()=>{})
 expect(calls).toEqual(['sync'])
 pending.resolve(wallet());await opening;await preparing
 expect(calls).toEqual(['sync','prepare'])
})
