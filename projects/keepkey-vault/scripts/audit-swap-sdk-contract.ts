// Same installed SDK as Vault. Public ETH fixtures only; no signing/broadcast.
const saved={log:console.log,info:console.info,debug:console.debug,warn:console.warn,error:console.error};
for(const method of Object.keys(saved)) (console as any)[method]=()=>{};
const sdk=await import('@pioneer-platform/pioneer-client');
const Pioneer=sdk.Pioneer||sdk.default;
const quote={sellAsset:'eip155:1/slip44:60',buyAsset:'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',sellAmount:'0.013118195',senderAddress:'0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',recipientAddress:'0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',slippage:3};
const observations=[];
for(const origin of ['https://api.keepkey.info','https://oracles.cc']){
 const queryKey=`vault:sdk-parity:${crypto.randomUUID()}:${crypto.randomUUID()}`;
 const registration=await fetch(origin+'/api/v1/user/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:`sdk-parity-${crypto.randomUUID()}`,queryKey}),signal:AbortSignal.timeout(15000)});
 if(!registration.ok)throw new Error(`Fixture registration failed: ${origin} HTTP ${registration.status}`);
 const client=await new Pioneer(origin+'/spec/swagger.json',{queryKey,timeout:45000}).init();
 for(const withMode of [false,true]){
  try{
   const response=await client.Quote({...quote,...(withMode?{relayExecutionMode:'solver-deposit'}:{})});
   const entries=response.data?.data||response.data;
   observations.push({origin,withMode,success:true,providers:Array.isArray(entries)?entries.map((e:any)=>e.integration):undefined});
  }catch(error:any){observations.push({origin,withMode,success:false,status:error.status||error.response?.status||error.responseError?.status,message:error.message,responseMessage:error.response?.body?.message||error.response?.body?.error?.message});}
 }
}
for(const [method,fn]of Object.entries(saved))(console as any)[method]=fn;
const report={checkedAt:new Date().toISOString(),sdk:'Vault installed @pioneer-platform/pioneer-client',fixtureOnly:true,signed:false,broadcast:false,observations};
console.log(JSON.stringify(report,null,2));await Bun.write(process.argv[2] || '/private/tmp/swap-provider-sdk-contract.json',JSON.stringify(report,null,2));
if(process.argv.includes('--check-current-client') && observations.some(row=>row.withMode && !row.success)) process.exitCode=1;
export {};

