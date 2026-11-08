/** Bounded 65002/65003 research candidate: host BP+ generation and independent verification. */
import { dlopen, ptr, FFIType } from 'bun:ffi'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519'
import { keccak_256 } from '@noble/hashes/sha3'
import { moneroStandardAddressKeys } from '../shared/monero-address'
import { validatePlan, type MoneroPlan } from '../../monero-cli/src/protocol'
import { concat, lengthField, MoneroError, parseSignedTransaction, signRequest } from './monero-wire'
export const MONERO_DEVICE_CANDIDATE_SHA256='9bc7798fb71a744c23a81cb7987645b7b5418d16fd035acc00770d57d4ae4928'
const PROOF_SHA='51043c3d5645705deb25095936be9c6a4d27d0426e2d6b14fabc1580bc09a492'
const VERIFY_SHA='6f3aac3710a698fdb515860156302592cb0f6fe0c79df3fe69b86d7a97e2484c'
const L=(1n<<252n)+27742317777372353535851937790883648493n
const unhex=(s:string)=>Uint8Array.from(s.match(/../g)!,x=>parseInt(x,16))
const scalar=(a:Uint8Array)=>a.reduceRight((n,b)=>(n<<8n)|BigInt(b),0n)
const bytes=(n:bigint)=>Uint8Array.from({length:32},(_,i)=>Number((n>>BigInt(8*i))&255n))
const hs=(data:Uint8Array)=>scalar(keccak_256(data))%L
const text=(s:string)=>new TextEncoder().encode(s)
const eq=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((n,i)=>n===b[i])
const H=ed25519.ExtendedPoint.fromHex('8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94')
export interface MoneroDeviceSigner {
 available(firmwareHash?:string):boolean
 prepare(plan:MoneroPlan):Promise<{payload:Uint8Array;verify(blob:Uint8Array):boolean;dispose():void}>
}
export function checkDeviceSigningBounds(plan:MoneroPlan) {
 validatePlan({status:'pass',network:plan.network,fee:plan.feeAtomic,
  inputs:plan.inputs.map(i=>({amount:i.amountAtomic,real_member:i.realMember,output_index:i.outputIndex,subaddress_major:i.subaddressMajor,subaddress_minor:i.subaddressMinor,tx_public_key:i.txPublicKey,mask:i.mask,additional_tx_public_keys:i.additionalTxPublicKeys,ring:i.ring.map(r=>({global_index:r.globalIndex,public_key:r.publicKey,commitment:r.commitment}))})),
  outputs:plan.outputs.map(o=>({amount:o.amountAtomic,address:o.address,is_change:o.isChange,change_major:o.changeMajor,change_minor:o.changeMinor}))})
 if(plan.inputs.length!==1)throw new MoneroError('This firmware supports one Monero input per send. Choose an amount covered by one received output.')
 if(plan.outputs.length!==2)throw new MoneroError('This firmware requires exactly two Monero outputs, including change.')
 if(plan.outputs.some(o=>!moneroStandardAddressKeys(o.address)))throw new MoneroError('This firmware supports standard Monero destination addresses only. Use the recipient’s primary address starting with 4.')
 if(plan.inputs[0].additionalTxPublicKeys.length)throw new MoneroError('This firmware cannot spend outputs with additional transaction keys.')
 if(plan.outputs.some(o=>o.isChange&&(o.changeMajor!==0||o.changeMinor!==0)))throw new MoneroError('This firmware requires change to the wallet’s main address.')
}
/** C ABI from the pinned Core verifier; checked against monero_core_plan_size at load. */
export function deviceNativePlan(plan:MoneroPlan):Uint8Array {
 checkDeviceSigningBounds(plan)
 const data=new Uint8Array(7544),v=new DataView(data.buffer)
 v.setUint32(0,plan.network,true);v.setUint32(4,1,true);v.setUint32(8,2,true);v.setBigUint64(16,BigInt(plan.feeAtomic),true)
 const input=plan.inputs[0],base=24
 v.setBigUint64(base,BigInt(input.amountAtomic),true)
 for(const [i,n] of [input.realMember,input.outputIndex,input.subaddressMajor,input.subaddressMinor].entries())v.setUint32(base+8+i*4,n,true)
 data.set(unhex(input.txPublicKey),base+24);data.set(unhex(input.mask),base+56)
 input.ring.forEach((r,i)=>{const offset=base+608+i*72;v.setBigUint64(offset,BigInt(r.globalIndex),true);data.set(unhex(r.publicKey),offset+8);data.set(unhex(r.commitment),offset+40)})
 plan.outputs.forEach((o,i)=>{const offset=7064+i*120;v.setBigUint64(offset,BigInt(o.amountAtomic),true);data.set(text(o.address),offset+8);v.setUint32(offset+104,o.isChange?1:0,true);v.setUint32(offset+108,o.changeMajor,true);v.setUint32(offset+112,o.changeMinor,true)})
 return data
}
export function deviceOutputBindings(plan:MoneroPlan,txKey:Uint8Array) {
 checkDeviceSigningBounds(plan)
 const secret=scalar(txKey)
 if(secret===0n||secret>=L)throw new MoneroError('Invalid Monero transaction key')
 const publicKey=ed25519.ExtendedPoint.BASE.multiply(secret).toRawBytes()
 const masks:Uint8Array[]=[],outputs:Uint8Array[]=[],amounts:Uint8Array[]=[],commitments:Uint8Array[]=[]
 plan.outputs.forEach((o,i)=>{
  const keys=moneroStandardAddressKeys(o.address)!,view=ed25519.ExtendedPoint.fromHex(keys.view,false),spend=ed25519.ExtendedPoint.fromHex(keys.spend,false)
  if(view.isSmallOrder()||!view.isTorsionFree()||spend.isSmallOrder()||!spend.isTorsionFree())throw new MoneroError('Invalid Monero destination public key')
  const derivation=view.multiply(secret).multiply(8n).toRawBytes(),indexed=concat([derivation,new Uint8Array([i])]),shared=hs(indexed)
  const out=ed25519.ExtendedPoint.BASE.multiply(shared).add(spend).toRawBytes(),tag=keccak_256(concat([text('view_tag'),indexed]))[0]
  outputs.push(concat([new Uint8Array([0,3]),out,new Uint8Array([tag])]))
  const amountHash=keccak_256(concat([text('amount'),bytes(shared)])),amount=new Uint8Array(8)
  for(let j=0;j<8;j++)amount[j]=Number((BigInt(o.amountAtomic)>>BigInt(8*j))&255n)^amountHash[j]
  amounts.push(amount)
  const mask=hs(concat([text('commitment_mask'),bytes(shared)]));masks.push(bytes(mask))
  commitments.push(ed25519.ExtendedPoint.BASE.multiply(mask).add(H.multiply(BigInt(o.amountAtomic))).toRawBytes())
 })
 return {masks:concat(masks),outputData:concat(outputs),extra:concat([new Uint8Array([1]),publicKey]),encryptedAmounts:concat(amounts),commitments:concat(commitments)}
}
function checkedLibrary(file:string,hash:string) {
 try {const stat=lstatSync(file);return stat.isFile()&&!stat.isSymbolicLink()&&!(stat.mode&0o022)&&createHash('sha256').update(readFileSync(file).toString('hex'),'hex').digest('hex')===hash}catch{return false}
}
const loadProver=(file:string)=>dlopen(file,{monero_device_proof:{args:[FFIType.ptr,FFIType.ptr,FFIType.ptr],returns:FFIType.i32}})
const loadVerifier=(file:string)=>dlopen(file,{monero_core_verify:{args:[FFIType.ptr,FFIType.ptr,FFIType.u64,FFIType.ptr],returns:FFIType.i32},monero_core_plan_size:{args:[],returns:FFIType.u64}})
export function createMoneroDeviceSigner(options:{directory?:string}={}):MoneroDeviceSigner {
 function libraries(){
  if(process.platform!=='darwin'||process.arch!=='arm64')return null
  const roots=options.directory?[options.directory]:[resolve(import.meta.dir,'../monero-device'),join(dirname(process.execPath),'monero-device'),resolve(process.cwd(),'monero-device-bundle')]
  for(const root of roots){const proof=join(root,'libmonero_device_proof.dylib'),verify=join(root,'libmonero_core_verify.dylib');if(checkedLibrary(proof,PROOF_SHA)&&checkedLibrary(verify,VERIFY_SHA))return {proof,verify}}
  return null
 }
 return {
  available:hash=>hash===MONERO_DEVICE_CANDIDATE_SHA256&&!!libraries(),
  async prepare(plan){
   checkDeviceSigningBounds(plan)
   const files=libraries();if(!files)throw new MoneroError('The hardware Monero proof and verification tools are unavailable in this build')
   const native=deviceNativePlan(plan),proof=new Uint8Array(642),amounts=new Uint8Array(16),values=new DataView(amounts.buffer)
   plan.outputs.forEach((o,i)=>values.setBigUint64(i*8,BigInt(o.amountAtomic),true))
   const entropy=crypto.getRandomValues(new Uint8Array(64)),key=bytes(scalar(entropy)%(L-1n)+1n);entropy.fill(0)
   const binding=deviceOutputBindings(plan,key)
   let prover:ReturnType<typeof loadProver>|null=null,verifier:ReturnType<typeof loadVerifier>|null=null,payload:Uint8Array|null=null
   const dispose=()=>{payload?.fill(0);key.fill(0);binding.masks.fill(0);native.fill(0);prover?.close();verifier?.close();prover=null;verifier=null}
   try {
    prover=loadProver(files.proof)
    verifier=loadVerifier(files.verify)
    if(Number(verifier.symbols.monero_core_plan_size())!==native.length)throw new MoneroError('Monero verification ABI mismatch')
    if(prover.symbols.monero_device_proof(ptr(amounts),ptr(binding.masks),ptr(proof))!==1)throw new MoneroError('Monero output proof generation failed')
    // The emulator plan's trailing field 6 (unlock_time=0) is replaced by the candidate tx scalar and proof.
    const encoded=signRequest(plan)
    payload=concat([encoded.subarray(0,encoded.length-2),lengthField(6,key),lengthField(7,proof)])
    key.fill(0);binding.masks.fill(0)
    return {payload,dispose,verify(blob){
     if(!verifier)return false
     const parsed=parseSignedTransaction(blob)
     if(!eq(parsed.outputData,binding.outputData)||!eq(parsed.extra,binding.extra)||!eq(parsed.encryptedAmounts,binding.encryptedAmounts)||!eq(parsed.commitments,binding.commitments))return false
     const error=new Uint8Array(192)
     try{return verifier.symbols.monero_core_verify(ptr(native),ptr(blob),blob.length,ptr(error))===1}finally{error.fill(0)}
    }}
   } catch(error){dispose();throw error}
  },
 }
}
