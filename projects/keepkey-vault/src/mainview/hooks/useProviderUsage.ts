import {useEffect,useState} from 'react'
import type {ProviderUsageStatus} from '../../shared/provider-refresh'
import {onRpcMessage,rpcRequest} from '../lib/rpc'

/** Poll our server's inexpensive status, never a provider's wallet endpoints. */
export function useProviderUsage(){
 const [usage,setUsage]=useState<ProviderUsageStatus|null>(null)
 useEffect(()=>{
  let active=true,generation=0,running=false
  const check=async()=>{
   if(running)return
   running=true
   const epoch=generation
   try{
    const value=await rpcRequest<ProviderUsageStatus|null>('getProviderUsage',undefined,15000)
    if(active&&epoch===generation)setUsage(value)
   }catch{/* Balance errors have their own banner; retain an existing quota warning. */}
   finally{running=false}
  }
  void check()
  const timer=setInterval(()=>void check(),60000)
  const off=onRpcMessage('pioneer-server-changed',()=>{generation++;setUsage(null);void check()})
  return()=>{active=false;generation++;clearInterval(timer);off()}
 },[])
 return usage
}
