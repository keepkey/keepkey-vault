import {expect,test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {parseExactJson,validatePlan} from '../../monero-cli/src/protocol'
import {bytesField,parseFields,parseSignedTransaction} from './monero-wire'
import {checkDeviceSigningBounds,deviceNativePlan,deviceOutputBindings,createMoneroDeviceSigner} from './monero-device-signing'
const source=parseExactJson(readFileSync(new URL('./monero-send.fixtures.json',import.meta.url),'utf8'))
const fixture=JSON.parse(readFileSync(new URL('./monero-device.fixtures.json',import.meta.url),'utf8'))
const plan=()=>validatePlan(structuredClone(source.cases.base.adapterPlan))
const unhex=(s:string)=>Uint8Array.from(s.match(/../g)!,x=>parseInt(x,16))
test('native plan encoding equals the qualified Core ABI fixture hash',()=>{
 expect(createHash('sha256').update(deviceNativePlan(plan())).digest('hex')).toBe('d533c3d3aac34173a9ebe689f1e8b1566f3633fdf7f0c163c84754f6888a8bea')
})
test('host output bindings exactly match the candidate C signer for both standard outputs',()=>{
 const request=parseFields(unhex(fixture.requestHex)),binding=deviceOutputBindings(plan(),bytesField(request,6)),signed=parseSignedTransaction(unhex(fixture.transactionHex))
 expect(signed.hash).toBe(fixture.txid)
 for(const key of ['outputData','extra','encryptedAmounts','commitments'] as const)expect(binding[key]).toEqual(signed[key])
 expect(bytesField(request,7)).toHaveLength(642)
})
test('changing a recipient or approved amount changes the exact output bindings',()=>{
 const key=bytesField(parseFields(unhex(fixture.requestHex)),6),original=deviceOutputBindings(plan(),key)
 const recipient=plan();recipient.outputs[0].address=recipient.outputs[1].address
 expect(deviceOutputBindings(recipient,key).outputData).not.toEqual(original.outputData)
 const amount=plan();amount.outputs[0].amountAtomic='1'
 expect(deviceOutputBindings(amount,key).encryptedAmounts).not.toEqual(original.encryptedAmounts)
 expect(deviceOutputBindings(amount,key).commitments).not.toEqual(original.commitments)
})
test('the current candidate explicitly rejects subaddresses, multiple inputs and additional input keys',()=>{
 const sub=plan();sub.outputs[0].address='84AxZu7xYb7fi7hnQrgTBdHFyP2xz6vdrZbLaJxbe73JJTWj6JG4cV8cbNnEhMvvi9PxSHvGnXQiaaLf2HNXJfzFKtWqk3H'
 expect(()=>checkDeviceSigningBounds(sub)).toThrow('standard Monero destination')
 const multi=plan();multi.inputs.push(structuredClone(multi.inputs[0]));expect(()=>checkDeviceSigningBounds(multi)).toThrow('one Monero input')
 const additional=plan();additional.inputs[0].additionalTxPublicKeys.push(additional.inputs[0].txPublicKey)
 expect(()=>checkDeviceSigningBounds(additional)).toThrow('additional transaction')
})
test('a missing pinned tool bundle cannot enable hardware signing',()=>{
 const signer=createMoneroDeviceSigner({directory:'/private/tmp/nonexistent-monero-tools'})
 expect(signer.available('unknown')).toBe(false)
})
