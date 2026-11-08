import {expect,test} from 'bun:test'
import {MoneroWatchService} from './wallet'
const image={keyImage:'11'.repeat(32),signature:'22'.repeat(64)}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}
function fixture(){
 const service=new MoneroWatchService('/not-used');const internal=service as any
 const gate=deferred();const calls:string[]=[];let refreshes=0
 const session:any={address:'fixture-address',restoreHeight:0,daemonUrl:'http://127.0.0.1:18081',daemonSynchronized:true,daemonHeight:100,nodeAnsweredAt:Date.now(),
  status:{network:'mainnet',address:'fixture-address',balanceAtomic:'9000000000000',unlockedBalanceAtomic:'9000000000000',walletHeight:100,transactions:[],monitorReady:true,canSend:false},
  rpc:{call:async(method:string)=>{
   calls.push(method)
   if(method==='refresh'){if(++refreshes===1)await gate.promise;return {}}
   if(method==='get_height')return {height:100}
   if(method==='get_balance')return {balance:refreshes===1?'9000000000000':'7000000000000',unlocked_balance:refreshes===1?'9000000000000':'7000000000000'}
   if(method==='get_transfers')return {in:[],pool:[]}
   if(method==='import_key_images')return {height:100,spent:'2000000000000',unspent:'7000000000000'}
   throw new Error('Unexpected RPC: '+method)
  }} }
 internal.session=session
 return {service,internal,session,gate,calls}
}
test('key-image import waits for a new post-import balance, even with a pre-import refresh in flight',async()=>{
 const {service,gate,calls}=fixture()
 const old=service.refresh();let done=false
 const imported=service.importKeyImages({offset:0,signedKeyImages:[image]}).finally(()=>{done=true})
 await Bun.sleep(5)
 try{expect(done).toBe(false)}finally{gate.resolve();await old;await imported}
 expect(calls.filter(x=>x==='refresh')).toHaveLength(2)
 expect(service.getStatus().balanceAtomic).toBe('7000000000000')
 expect(service.getStatus().unlockedBalanceAtomic).toBe('7000000000000')
})
test('an import from a replaced watch wallet cannot refresh the new wallet',async()=>{
 const {service,internal,gate,session,calls}=fixture()
 const old=service.refresh().catch(()=>{})
 const imported=service.importKeyImages({offset:0,signedKeyImages:[image]});imported.catch(()=>{})
 await Bun.sleep(5);internal.session={...session,rpc:{call:()=>{throw new Error('Replacement wallet was used')}}};gate.resolve()
 await old;await expect(imported).rejects.toThrow('wallet changed')
 expect(calls.filter(x=>x==='refresh')).toHaveLength(1)
})
