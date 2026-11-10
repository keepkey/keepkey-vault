import {expect,test} from 'bun:test'
import {createMoneroFailoverVault,moneroFailoverCandidates} from './monero-remote-failover'
import type {createMoneroVault,MoneroVaultStatus} from './monero-vault'
import {MONERO_STANDARD_WALLET_REQUIRED,MoneroWalletPolicyError} from '../shared/monero-wallet-policy'
const primary='https://node.sethforprivacy.com',fallback='https://xmr.triplebit.org'
const tick=()=>Bun.sleep(5)
function fixture(){
 let clock=100_000,opened=false,connectError:Error|null=null,hidden=false
 let beforeCheck:(()=>void|Promise<void>)|null=null
 const config={enabled:true,offline:false,daemonUrl:primary,restoreHeight:100}
 const calls:{check:string[];connect:string[];sign:number;relay:number}={check:[],connect:[],sign:0,relay:0}
 const failed=new Set<string>()
 const status={available:true,enabled:true,deviceReady:true,connected:true,sidecarReady:true,network:'mainnet',address:'public-wallet',balanceAtomic:'100',unlockedBalanceAtomic:'100',walletHeight:200,transactions:[],monitorReady:true,syncState:'ready',emulatorReady:false,canSend:true,keyImagesSynced:true,spendStateKnown:true} as MoneroVaultStatus
 let effective=()=>config
 const api=createMoneroFailoverVault({getConfig:()=>({...config}),now:()=>clock,retryMs:30_000,probeMs:15_000,
  assertAllowed:()=>{if(hidden)throw new MoneroWalletPolicyError()},
  checkNode:async url=>{calls.check.push(url);await beforeCheck?.();if(failed.has(url))throw Error('Request timed out');return {height:200}},
  create:getConfig=>{effective=getConfig;return {
   connect:async()=>{calls.connect.push(effective().daemonUrl);if(!effective().enabled||effective().offline)throw Error('Monero is disabled or offline');if(connectError)throw connectError;opened=true;return {...status}},
   getStatus:async()=>hidden?{...status,available:false,connected:false,address:'',transactions:[],error:MONERO_STANDARD_WALLET_REQUIRED,syncState:'not-connected'}:opened?{...status}:{...status,available:false,connected:false,syncState:'not-connected'},
   stop:()=>{opened=false},invalidate:()=>{opened=false},pendingCount:()=>status.unrelayedTxid?1:0,
   getAddress:async()=>({address:'public-wallet',network:'mainnet',displayed:false,minor:0}),syncKeyImages:async()=>({...status}),
   prepareSend:async()=>({prepareId:'review'}),send:async()=>{calls.sign++;return {txid:'tx'}},retryRelay:async()=>{calls.relay++;return {txid:'tx'}},discardPending:async()=>({outcome:'discarded',txid:'tx'}),
  } as unknown as ReturnType<typeof createMoneroVault>},
 })
 return {api,status,config,calls,failed,advance:(ms:number)=>{clock+=ms},cancel:()=>{connectError=Error('The KeepKey rejected or cancelled the Monero request')},
  hide:()=>{hidden=true},beforeCheck:(hook:()=>void|Promise<void>)=>{beforeCheck=hook}}
}
test('an unreachable preset fails over before asking the device, with visible reason and active node',async()=>{
 const f=fixture();f.failed.add(primary)
 const status=await f.api.connect()
 expect(f.calls.check).toEqual([primary,fallback]);expect(f.calls.connect).toEqual([fallback])
 expect(status.connection).toMatchObject({preferredNode:primary,activeNode:fallback,automaticFailover:true,state:'connected'})
 expect(status.connection!.attempts[0]).toMatchObject({state:'failed',error:'The node did not respond within 10 seconds.'})
 expect(status.monitorReady).toBe(true)
})
test('a failed monitoring connection switches nodes without signing or relaying anything',async()=>{
 const f=fixture();await f.api.connect();f.status.syncState='unreachable';f.status.monitorReady=false
 await f.api.getStatus();await tick()
 expect(f.calls.connect).toEqual([primary,fallback]);expect((await f.api.getStatus()).connection!.activeNode).toBe(fallback)
 expect(f.calls.sign).toBe(0);expect(f.calls.relay).toBe(0)
})
test('a cancelled device approval never asks again through another node',async()=>{
 const f=fixture();f.cancel()
 await expect(f.api.connect()).rejects.toThrow('cancelled')
 f.advance(60_000);await f.api.getStatus();await tick()
 expect(f.calls.check).toEqual([primary]);expect(f.calls.connect).toEqual([primary])
})
for(const kind of ['review','broadcast'])test(`automatic changes pause during a pending ${kind}`,async()=>{
 const f=fixture();await f.api.connect()
 if(kind==='review')await f.api.prepareSend({address:'recipient',amountAtomic:'1'})
 else f.status.unrelayedTxid='pending-tx'
 f.status.syncState='unreachable';f.status.monitorReady=false
 const status=await f.api.getStatus();await tick()
 expect(f.calls.connect).toEqual([primary]);expect(status.connection!.pausedForTransaction).toBe(true)
 expect(f.calls.sign).toBe(0);expect(f.calls.relay).toBe(0)
})
for(const url of ['http://127.0.0.1:18081','https://private.example'])test(`${url} never silently uses public fallbacks`,async()=>{
 const f=fixture();f.config.daemonUrl=url;await f.api.connect();f.status.syncState='unreachable'
 f.advance(60_000);const status=await f.api.getStatus();await tick()
 expect(moneroFailoverCandidates(url)).toEqual([url]);expect(status.connection!.automaticFailover).toBe(false)
 expect(f.calls.connect).toEqual([url]);expect(f.calls.check).toEqual([])
})
test('exhausted nodes use a bounded cooldown instead of a tight retry loop',async()=>{
 const f=fixture();f.failed.add(primary);f.failed.add(fallback)
 await expect(f.api.connect()).rejects.toThrow('try again automatically')
 expect(f.calls.check).toHaveLength(2)
 f.advance(29_000);let status=await f.api.getStatus();await tick()
 expect(f.calls.check).toHaveLength(2);expect(status.connection!.state).toBe('waiting');expect(status.connection!.retryAt).toBeDefined()
 f.advance(2000);await f.api.getStatus();await tick();expect(f.calls.check).toHaveLength(4)
})


test('disabling monitoring during a node check cannot open the wallet afterward',async()=>{
 let resolve!:(value:{height:number})=>void,opened=0
 let config={enabled:true,offline:false,daemonUrl:primary,restoreHeight:0}
 const gate=new Promise<{height:number}>(r=>{resolve=r})
 const api=createMoneroFailoverVault({getConfig:()=>config,checkNode:()=>gate,create:()=>({invalidate(){},connect:async()=>{opened++;throw Error('must not open')},pendingCount:()=>0}) as unknown as ReturnType<typeof createMoneroVault>})
 const pending=api.connect();api.invalidate();config={...config,enabled:false};resolve({height:200})
 await expect(pending).rejects.toThrow('connection changed');expect(opened).toBe(0)
})


for(const flag of ['disabled','offline'])test(`${flag} monitoring never probes remote nodes`,async()=>{
 const f=fixture();if(flag==='disabled')f.config.enabled=false;else f.config.offline=true
 await expect(f.api.connect()).rejects.toThrow('disabled or offline')
 expect(f.calls.check).toHaveLength(0)
})


test('a restored pending broadcast cannot trigger fallback while opening the wallet',async()=>{
 const f=fixture();f.status.unrelayedTxid='previous-broadcast';f.failed.add(primary)
 await expect(f.api.connect()).rejects.toThrow('transaction is pending')
 expect(f.calls.check).toEqual([primary]);expect(f.calls.connect).toHaveLength(0)
 expect((await f.api.getStatus()).connection!.pausedForTransaction).toBe(true)
})

test('hidden wallet policy prevents public probes, wallet access and automatic reconnects',async()=>{
 const f=fixture();f.hide()
 expect(()=>f.api.connect()).toThrow(MONERO_STANDARD_WALLET_REQUIRED)
 await expect(f.api.getAddress({})).rejects.toThrow(MONERO_STANDARD_WALLET_REQUIRED)
 const status=await f.api.getStatus();await tick()
 expect(status).toMatchObject({available:false,address:'',transactions:[],error:MONERO_STANDARD_WALLET_REQUIRED})
 expect(f.calls.check).toEqual([]);expect(f.calls.connect).toEqual([]);expect(f.calls.sign).toBe(0);expect(f.calls.relay).toBe(0)
})
test('becoming hidden during a node probe cannot open a wallet or try another public node',async()=>{
 const f=fixture();f.beforeCheck(()=>f.hide())
 await expect(f.api.connect()).rejects.toThrow(MONERO_STANDARD_WALLET_REQUIRED)
 expect(f.calls.check).toEqual([primary]);expect(f.calls.connect).toEqual([])
 const status=await f.api.getStatus();expect(status.address).toBe('')
 expect(f.calls.check).toEqual([primary])
})
test('an existing standard monitor is invalidated on hidden transition without a background probe',async()=>{
 const f=fixture();await f.api.connect();f.advance(60_000);f.hide()
 const status=await f.api.getStatus();await tick()
 expect(status).toMatchObject({available:false,address:'',error:MONERO_STANDARD_WALLET_REQUIRED})
 expect(f.calls.check).toEqual([primary]);expect(f.calls.connect).toEqual([primary])
})
