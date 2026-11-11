/** Remote monitoring failover. It never prepares, signs or retries a transaction. */
import { createMoneroVault, type MoneroVaultConfig, type MoneroVaultStatus } from './monero-vault'
import { checkMoneroNode } from './monero-settings'
import { MONERO_REMOTE_NODES } from '../shared/monero-node'
import type { MoneroConnectionInfo } from '../shared/types'

type Vault = ReturnType<typeof createMoneroVault>
const clean = (url: string) => url.replace(/\/$/,'')
export function moneroFailoverCandidates(preferred: string): string[] {
  const url = clean(preferred)
  // Deliberate custom/private or local connections never opt into public fallback.
  return MONERO_REMOTE_NODES.some(node => node.url === url)
    ? [url,...MONERO_REMOTE_NODES.map(node=>node.url).filter(node=>node!==url)] : [url]
}
function publicReason(error: unknown): string {
  const message=error instanceof Error?error.message:''
  if(/still syncing/i.test(message))return 'The node is still syncing.'
  if(/timeout|timed out|within 10 seconds|aborted/i.test(message))return 'The node did not respond within 10 seconds.'
  if(/TLS|certificate|fingerprint/i.test(message))return 'The node TLS identity could not be verified.'
  const http=/HTTP ([45][0-9]{2})/.exec(message)
  return http?`The node returned HTTP ${http[1]}.`:'The node did not return a usable Monero mainnet response.'
}
const nodeError=(error:unknown)=>error instanceof Error && /Monero (?:daemon|node|watch wallet)|watch-only Monero operation|private Monero wallet RPC/i.test(error.message)

export function createMoneroFailoverVault({create,getConfig,checkNode=checkMoneroNode,now=Date.now,retryMs=30_000,probeMs=15_000,assertAllowed=()=>{}}:{
 create:(config:()=>MoneroVaultConfig)=>Vault;getConfig:()=>MoneroVaultConfig
 checkNode?:(url:string)=>Promise<{height:number}>;now?:()=>number;retryMs?:number;probeMs?:number
 assertAllowed?:()=>void
}):Vault {
 let key='',urls:string[]=[],active='',generation=0,sessionId=0,requested=false,inFlight=0,preparedUntil=0,nextRetry=0,lastProbe=0
 let connecting:Promise<MoneroVaultStatus>|null=null,probing:Promise<void>|null=null
 let state:MoneroConnectionInfo['state']='idle'
 let attempts:MoneroConnectionInfo['attempts']=[]
 let lastStatus:MoneroVaultStatus|null=null
 function pool(){
  const config=getConfig(),next=JSON.stringify([config.enabled,config.offline,config.daemonUrl,config.restoreHeight])
  if(next!==key){key=next;generation++;urls=moneroFailoverCandidates(config.daemonUrl);active=urls[0];preparedUntil=0;lastStatus=null;attempts=urls.map(url=>({url,state:'untested'}));nextRetry=0;lastProbe=0;state='idle'}
  return config
 }
 const vault=create(()=>{const config=pool();return {...config,daemonUrl:active||config.daemonUrl}})
 const entry=(url:string)=>attempts.find(item=>item.url===url)!
 const info=():MoneroConnectionInfo=>({sessionId,preferredNode:urls[0],activeNode:active,automaticFailover:urls.length>1,state,
  attempts:attempts.map(item=>({...item})),...(nextRetry?{retryAt:new Date(nextRetry).toISOString()}:{}),
  ...(preparedUntil>now()||vault.pendingCount()>0||lastStatus?.unrelayedTxid?{pausedForTransaction:true}:{})})
 const decorate=(status:MoneroVaultStatus,waiting=!!connecting):MoneroVaultStatus=>({...status,connection:info(),
  ...(waiting&&status.available?{monitorReady:false,canSend:false,syncState:'scanning' as const}: {})})
 const success=(url:string,height?:number,latencyMs?:number)=>Object.assign(entry(url),{state:'responding',checkedAt:new Date(now()).toISOString(),lastResponseAt:new Date(now()).toISOString(),error:undefined,retryAt:undefined,...(height===undefined?{}:{height}),...(latencyMs===undefined?{}:{latencyMs})})
 const failure=(url:string,error:unknown)=>Object.assign(entry(url),{state:'failed',checkedAt:new Date(now()).toISOString(),error:publicReason(error),retryAt:new Date(now()+retryMs).toISOString()})
 const eligible=(url:string)=>!entry(url).retryAt||Date.parse(entry(url).retryAt!)<=now()
 async function run<T>(operation:()=>Promise<T>){assertAllowed();inFlight++;try{const result=await operation();assertAllowed();return result}finally{inFlight--}}
 function connect(options:Parameters<Vault['connect']>[0]={},force=true):Promise<MoneroVaultStatus>{
  assertAllowed()
  if(connecting)return connecting
  const config=pool();const current=generation
  if (!config.enabled || config.offline) { requested=false; return vault.connect(options) }
  requested=true
  const work=(async()=>{
   inFlight++
   try {
    if(urls.length===1){
      try {const status=await vault.connect(options);if(current!==generation)throw Error('The Monero connection changed');success(active,status.daemonHeight);sessionId++;lastStatus=status;state=status.monitorReady?'connected':'scanning';return decorate(status,false)}
      catch(error){requested=false;state='failed';failure(active,error);throw error}
    }
    const paused=vault.pendingCount()>0||preparedUntil>now()
    const order=(paused?[active]:[active,...urls.filter(url=>url!==active)]).filter(url=>force||eligible(url))
    for(const url of order){
     assertAllowed()
     if(current!==generation)throw Error('The Monero connection changed')
     state=url===active?'checking':'switching';entry(url).state='checking'
     try {
      const began=now(),health=await checkNode(url)
      assertAllowed()
      if(current!==generation)throw Error('The Monero connection changed')
      success(url,health.height,Math.max(0,now()-began));state='idle'
      if(url!==active){vault.invalidate();active=url}
      const status=await vault.connect(options)
      if(current!==generation)throw Error('The Monero connection changed')
      sessionId++;lastStatus=status;state=status.monitorReady?'connected':'scanning';nextRetry=0;lastProbe=now()
      return decorate(status,false)
     }catch(error){
      if(current!==generation)throw error
      assertAllowed()
      // A device refusal/cancellation or USB fault must never trigger another consent prompt.
      if(entry(url).state==='responding'&&!nodeError(error)){requested=false;state='failed';throw error}
      failure(url,error)
     }
    }
    state=urls.length>1&&!paused?'waiting':'failed';nextRetry=urls.length>1&&!paused?now()+retryMs:0
    if(paused)throw Error('The current node is unavailable. Automatic node changes are paused while a transaction is pending.')
    throw Error(urls.length>1?'No remote Monero node responded. Vault will try again automatically.':'The selected Monero node did not respond. Check its address or choose another node.')
   }finally{inFlight--}
  })()
  connecting=work
  void work.finally(()=>{if(connecting===work)connecting=null}).catch(()=>{})
  return work
 }
 function backgroundConnect(){
  try{assertAllowed()}catch{return}
  if(connecting||inFlight||preparedUntil>now()||vault.pendingCount()>0||lastStatus?.unrelayedTxid||now()<nextRetry)return
  void connect({},false).catch(()=>{})
 }
 function probe(){
  try{assertAllowed()}catch{return}
  if(probing||connecting||now()-lastProbe<probeMs)return
  lastProbe=now();const current=generation,url=active,began=now()
  const work=(async()=>{
   try{const health=await checkNode(url);assertAllowed();if(current!==generation)return;success(url,health.height,Math.max(0,now()-began));if(!connecting)state=lastStatus?.monitorReady?'connected':'scanning'}
   catch(error){if(current!==generation)return;failure(url,error);state='failed';backgroundConnect()}
  })()
  probing=work;void work.finally(()=>{if(probing===work)probing=null}).catch(()=>{})
 }
 function invalidate(){generation++;key='';requested=false;preparedUntil=0;nextRetry=0;lastStatus=null;state='idle';vault.invalidate()}
 return {...vault,
  connect:options=>connect(options),
  invalidate,stop:invalidate,
  async getStatus(){
   try{assertAllowed()}catch{invalidate();return vault.getStatus()}
   const config=pool()
   const status=await vault.getStatus()
   try{assertAllowed()}catch{invalidate();return vault.getStatus()}
   lastStatus=status
   if(requested&&config.enabled&&!config.offline&&status.deviceReady&&urls.length>1){
    if(!connecting){
     if(status.syncState==='unreachable'){if(entry(active).state!=='failed')failure(active,Error(status.error||'Monero node unavailable'));state='failed';backgroundConnect()}
     else if(!status.available&&now()>=nextRetry)backgroundConnect()
     else if(status.available){if(state==='scanning'&&status.monitorReady)state='connected';probe()}
    }
   }
   return decorate(status)
  },
  getAddress:params=>run(()=>vault.getAddress(params)),
  syncKeyImages:()=>run(()=>vault.syncKeyImages()),
  prepareSend:params=>run(async()=>{const review=await vault.prepareSend(params);preparedUntil=now()+10*60_000;return review}),
  send:params=>run(async()=>{try{return await vault.send(params)}finally{preparedUntil=0}}),
  retryRelay:()=>run(()=>vault.retryRelay()),
  discardPending:params=>run(()=>vault.discardPending(params)),
 }
}
