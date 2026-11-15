import {expect,test} from 'bun:test'
import {createConnectivityState} from '../src/shared/connectivity'
import {probeNetworkReachability} from '../src/bun/network-probe'
import {createSyncProgressTracker} from '../src/bun/sync-progress'

test('one transient API failure or RPC timeout cannot flap connectivity',()=>{
 const state=createConnectivityState()
 expect(state.observe(false)).toBe(true)
 expect(state.observe(undefined)).toBe(true)
 expect(state.observe(true)).toBe(true)
 expect(state.observe(false)).toBe(true)
 expect(state.observe(false)).toBe(false)
 expect(state.observe(undefined)).toBe(false)
 expect(state.observe(true)).toBe(true)
})
test('server changes reset failures belonging to a different endpoint',()=>{
 const state=createConnectivityState();state.observe(false);state.reset()
 expect(state.observe(false)).toBe(true)
})
test('sync progress reports settled work, failures and elapsed phase tasks independently of data freshness',async()=>{
 let now=1000;const updates:any[]=[]
 const tracker=createSyncProgressTracker(value=>updates.push(value),()=>now)
 await tracker.run(async progress=>{
  progress.phase('balances',4)
  await progress.task('batch-1',async()=>{now+=20;return {failed:1}},2,result=>result.failed)
  expect(tracker.snapshot()).toMatchObject({completed:2,total:4,percent:50,failed:1,status:'running'})
  await progress.task('batch-2',async()=>{now+=10},2)
 })
 expect(tracker.snapshot()).toMatchObject({completed:4,total:4,percent:100,status:'partial',elapsedMs:30})
 expect(tracker.recent()[0].tasks.map(task=>task.durationMs)).toEqual([20,10])
 now+=10_000
 expect(tracker.snapshot()).toMatchObject({elapsedMs:30,updatedAt:1030})
 expect(tracker.snapshot()).toEqual(tracker.recent()[0])
})
test('failed and paused syncs always reach a terminal state',async()=>{
 const tracker=createSyncProgressTracker(()=>{})
 await expect(tracker.run(async p=>{await p.task('rpc',async()=>{throw Error('offline')})})).rejects.toThrow('offline')
 expect(tracker.snapshot()?.status).toBe('failed')
 await tracker.run(async p=>{p.pause()})
 expect(tracker.snapshot()?.status).toBe('paused')
})


test('connectivity checks the edge instead of starting the gateway container; HTTP errors still mean reachable',async()=>{
 const calls:string[]=[]
 const result=await probeNetworkReachability('https://api-blue.keepkey.info', (async(input:any)=>{calls.push(String(input));return new Response('',{status:503})}) as unknown as typeof fetch)
 expect(calls).toEqual(['https://api-blue.keepkey.info/cdn-cgi/trace'])
 expect(result).toMatchObject({online:true,status:503})
 const failed=await probeNetworkReachability('https://api-blue.keepkey.info', (async()=>{throw new TypeError('network unavailable')}) as unknown as typeof fetch)
 expect(failed.online).toBe(false)
})
