import {afterAll,test,expect,mock} from 'bun:test'
import {EventEmitter} from 'node:events'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
mock.module('@keepkey/hdwallet-keepkey-nodehid',()=>({HIDKeepKeyAdapter:class{}}))
const dir=mkdtempSync(join(tmpdir(),'vault-multisig-feature-'))
mock.module('electrobun/bun',()=>({Utils:{paths:{userData:dir}}}))
const db=await import('../db')
const {startRestApi}=await import('../rest-api')
db.initDb()
afterAll(()=>{db.closeDb();rmSync(dir,{recursive:true,force:true})})
async function sign(enabled:boolean,disableAtApproval=false,multisig=true){
 db.setSetting('btc_multisig_enabled',enabled?'1':'0')
 let approvals=0,signatures=0
 const wallet={btcSignTx:async()=>{signatures++;return{signatures:['3006020101020101'],serializedTx:'01000000'}}}
 const engine:any=Object.assign(new EventEmitter(),{isEmulator:false,isPassphraseWallet:false,wallet,getDeviceState:()=>({state:'ready',firmwareVersion:'7.16.0'}),getCachedFeaturesSnapshot:()=>undefined})
 const auth:any={requireAuth:()=>({name:'test',url:'https://test.example'}),extractBearerToken:()=> 'test',validate:()=>true,getAccount:()=>undefined}
 const server=startRestApi(engine,auth,0,{onApiLog:()=>{},onPairRequest:()=>{},getVersion:()=> 'test',onSigningRequest:async()=>{approvals++;if(disableAtApproval)db.setSetting('btc_multisig_enabled','0');return{approved:true}},onSigningDismissed:()=>{}} as any, '127.0.0.1')
 try{
  const response=await fetch(`http://127.0.0.1:${server.port}/utxo/sign-transaction`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test'},body:JSON.stringify({coin:'Bitcoin',inputs:[{scriptType:'p2wpkh',amount:'1000',...(multisig?{multisig:{m:2,pubkeys:[]}}:{})}],outputs:[{address:'bc1qtest',amount:'900'}]})})
  return{status:response.status,body:await response.json(),approvals,signatures}
 }finally{server.stop(true)}
}
test('REST default-off blocks multisig before approval or USB signing',async()=>{
 const r=await sign(false);expect(r.status).toBe(403);expect(r.body.error).toContain('Settings');expect(r.approvals).toBe(0);expect(r.signatures).toBe(0)
})
test('REST explicit opt-in permits a normal approved multisig request',async()=>{
 const r=await sign(true);expect(r.status).toBe(200);expect(r.approvals).toBe(1);expect(r.signatures).toBe(1)
})
test('REST rechecks the flag after waiting for approval',async()=>{
 const r=await sign(true,true);expect(r.status).toBe(403);expect(r.approvals).toBe(1);expect(r.signatures).toBe(0)
})
test('REST single-signature signing is available with multisig off',async()=>{
 const r=await sign(false,false,false);expect(r.status).toBe(200);expect(r.signatures).toBe(1)
})
