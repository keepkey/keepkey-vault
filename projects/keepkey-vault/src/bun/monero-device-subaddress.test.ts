import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePlan } from '../../monero-cli/src/protocol'
import { bytesField, parseFields, parseSignedTransaction } from './monero-wire'
import { checkDeviceSigningBounds, createMoneroDeviceSigner, deviceNativePlan, deviceOutputBindings,
  moneroDeviceConstructionVersion, moneroDeviceNeedsMonitoringKey, MONERO_DEVICE_CANDIDATE_SHA256,
  MONERO_DEVICE_SUBADDRESS_CANDIDATE_SHA256 } from './monero-device-signing'

// Every secret in this file's fixture is derived from a published disposable
// mnemonic. No saved wallet, USB device, public node, or live payment is used.
const fixtures=JSON.parse(readFileSync(new URL('./monero-device-subaddress.fixtures.json',import.meta.url),'utf8'))
const unhex=(s:string)=>Uint8Array.from(Buffer.from(s,'hex'))
const vector=(name:string)=>fixtures.cases.find((c:any)=>c.name===name)
const plan=(c:any)=>validatePlan(structuredClone(c.adapterPlan))
const options=(c:any)=>({version:2 as const,additionalKeys:c.additionalTxKeysHex.map(unhex),senderViewKey:unhex(c.senderViewKeyHex)})

for(const c of fixtures.cases)test(`v2 Core classification, output keys and ABI: ${c.name}`,()=>{
 const p=plan(c),binding=deviceOutputBindings(p,unhex(c.txKeyHex),options(c)),parsed=parseSignedTransaction(unhex(c.transactionHex))
 for(const field of ['outputData','extra','encryptedAmounts','commitments'] as const)expect(binding[field]).toEqual(parsed[field])
 expect(createHash('sha256').update(deviceNativePlan(p,2)).digest('hex')).toBe(c.nativePlanSHA256)
 expect(()=>checkDeviceSigningBounds(p,2)).not.toThrow()
})

test('standard-address output behavior is preserved in construction versions one and two',()=>{
 const c=vector('v2-standard-network0'),p=plan(c),key=unhex(c.txKeyHex)
 expect(deviceOutputBindings(p,key)).toEqual(deviceOutputBindings(p,key,options(c)))
 expect(moneroDeviceNeedsMonitoringKey(p,1)).toBe(false)
 expect(moneroDeviceNeedsMonitoringKey(p,2)).toBe(false)
})

test('single subaddress plus change uses rD and requires the approved monitoring view key',()=>{
 const c=vector('v2-single-sub-network0'),p=plan(c),key=unhex(c.txKeyHex)
 expect(moneroDeviceNeedsMonitoringKey(p,2)).toBe(true)
 expect(()=>deviceOutputBindings(p,key,{version:2})).toThrow('Reconnect Monero monitoring')
 expect(()=>deviceOutputBindings(p,key,{version:2,senderViewKey:new Uint8Array(32).fill(1)})).toThrow('does not match change')
 expect(()=>checkDeviceSigningBounds(p)).toThrow('standard Monero destination')
})

test('mixed destinations require exactly two canonical additional transaction scalars',()=>{
 const c=vector('v2-mixed-network0'),p=plan(c),key=unhex(c.txKeyHex)
 expect(moneroDeviceNeedsMonitoringKey(p,2)).toBe(false)
 expect(()=>deviceOutputBindings(p,key,{version:2})).toThrow('additional transaction key count')
 expect(()=>deviceOutputBindings(p,key,{...options(c),additionalKeys:[new Uint8Array(32),unhex(c.additionalTxKeysHex[1])]})).toThrow('additional transaction scalar')
 const changed=deviceOutputBindings(p,key,{...options(c),additionalKeys:[unhex(c.txKeyHex),unhex(c.additionalTxKeysHex[1])]})
 expect(changed.outputData).not.toEqual(deviceOutputBindings(p,key,options(c)).outputData)
})

test('subaddress change and spending additional-key outputs retain bounded validation',()=>{
 const change=vector('v2-sub-change-network0')
 expect(moneroDeviceNeedsMonitoringKey(plan(change),2)).toBe(true)
 const c=vector('reuse-mixed'),p=plan(c)
 expect(()=>checkDeviceSigningBounds(p,2)).not.toThrow()
 expect(()=>checkDeviceSigningBounds(p,1)).toThrow('additional transaction')
 p.inputs[0].outputIndex=2
 expect(()=>checkDeviceSigningBounds(p,2)).toThrow('additional-key index')
})

test('construction v2 is selected only by the exact qualified image hash',()=>{
 expect(moneroDeviceConstructionVersion(MONERO_DEVICE_SUBADDRESS_CANDIDATE_SHA256)).toBe(2)
 for(const hash of [MONERO_DEVICE_CANDIDATE_SHA256,'7.17.0','unknown',undefined])expect(moneroDeviceConstructionVersion(hash)).toBe(1)
})

const library=process.env.MONERO_SUBADDRESS_FIRMWARE_LIBRARY
const helper=process.env.MONERO_SUBADDRESS_SIGN_HELPER
const directory=process.env.MONERO_SUBADDRESS_HOST_BUNDLE
for(const name of ['v2-standard-network0','v2-single-sub-network0','v2-mixed-network0','v2-sub-change-network0','reuse-mixed']){
 test.skipIf(!library||!helper||!directory)(`Vault host prepare -> firmware HID -> independent verification: ${name}`,async()=>{
  const c=vector(name),signer=createMoneroDeviceSigner({directory})
  expect(signer.available(MONERO_DEVICE_SUBADDRESS_CANDIDATE_SHA256)).toBe(true)
  expect(signer.available(MONERO_DEVICE_CANDIDATE_SHA256)).toBe(true)
  expect(signer.available('7.17.0')).toBe(false)
  const view=unhex(c.senderViewKeyHex)
  const prepared=await signer.prepare(plan(c),{firmwareHash:name==='v2-standard-network0'?MONERO_DEVICE_CANDIDATE_SHA256:MONERO_DEVICE_SUBADDRESS_CANDIDATE_SHA256,viewKey:view})
  try{
   expect(view).toEqual(unhex(c.senderViewKeyHex))
   expect(bytesField(parseFields(prepared.payload),7)).toHaveLength(642)
   const temp=mkdtempSync(join(tmpdir(),'vault-subaddress-ffi-')),request=join(temp,'request.bin'),output=join(temp,'transaction.bin')
   writeFileSync(request,prepared.payload)
   const child=Bun.spawnSync(['python3',helper!,'--library',library!,'--request',request,'--output',output],{stdout:'pipe',stderr:'pipe'})
   expect(child.exitCode).toBe(0)
   const blob=Uint8Array.from(readFileSync(output))
   expect(prepared.verify(blob)).toBe(true)
   const tampered=Uint8Array.from(blob);tampered[tampered.length-64]^=1
   expect(prepared.verify(tampered)).toBe(false)
  }finally{prepared.dispose();view.fill(0)}
  expect(prepared.payload.every(b=>b===0)).toBe(true)
 })
}
