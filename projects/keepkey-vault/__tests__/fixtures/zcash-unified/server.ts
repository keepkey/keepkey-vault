/** Synthetic native bridge for the real Zcash AssetPage. Never loads the DB. */
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
let enabled=true
const calls:string[]=[]
const address='u1'+'q'.repeat(140)
const balance={confirmed:200_000_000,pending:0,spendable_confirmed:200_000_000,max_send:199_990_000,max_deshield:199_985_000,synced_to:3_300_000,spendable_notes_count:1}
const rpc=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
 const {method,params:p}=await req.json();calls.push(method)
 let payload:unknown={}
 switch(method){
  case 'testReset':enabled=true;calls.length=0;break
  case 'testCalls':payload=[...calls];break
  case 'testSetPrivacy':enabled=p.enabled;break
  case 'getAppSettings':payload={zcashPrivacyEnabled:enabled,btcMultisigEnabled:false,passwordManagerEnabled:false};break
  case 'getSwappableChainIds':payload=['zcash'];break
  case 'getBtcAccounts':payload={accounts:[],totalBalanceUsd:0,totalBalance:'0'};break
  case 'getEvmAddresses':payload={addresses:[],selectedIndex:0,totalBalanceUsd:0};break
  case 'getUtxoAccounts':payload={accounts:[0]};break
  case 'getRecentActivity':case 'listSavedVaults':payload=[];break
  case 'getTokenVisibilityMap':payload={};break
  case 'getPublicKeys':payload=[{xpub:'Synthetic public fixture xpub'}];break
  case 'btcGetAddress':payload={address:'t1'+'A'.repeat(33)};break
  case 'getCachedBalances':payload={balances:[]};break
  case 'getActivityScanState':payload={running:false};break
  case 'zcashShieldedStatus':payload={ready:true,fvk_loaded:true,verified:true,synced:true,synced_to:3_300_000,address};break
  case 'zcashShieldedBalance':payload=balance;break
  case 'zcashGetTransactions':payload={transactions:[]};break
  case 'zcashShieldedScan':payload={synced_to:3_300_000};break
  case 'zcashTexPayments':payload={payments:[]};break
  case 'matchAddress':payload=null;break
  default:if(/Send|Sign|ShieldedInit|Deshield|ShieldZec|buildTx|broadcastTx/.test(method))return Response.json({success:false,error:'Device operations are disabled in this UI fixture'})
 }
 return Response.json({success:true,payload})
}})
const port=Number(process.env.ZCASH_UI_PORT || 5199)
const vite=await createServer({configFile:false,plugins:[react()],root:import.meta.dir,server:{host:'127.0.0.1',port,strictPort:true,fs:{allow:[new URL('../../../..',import.meta.url).pathname]},proxy:{'/__test_rpc':`http://127.0.0.1:${rpc.port}`}}})
await vite.listen()
console.log(`Zcash unified UI fixture: http://127.0.0.1:${port}`)
