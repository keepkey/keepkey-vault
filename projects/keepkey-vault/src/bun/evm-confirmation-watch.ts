import type {RecentActivity} from '../shared/types'

/** Confirmation checks use chain RPC, never a wallet-history discovery API. */
export async function readEvmConfirmationRows(
 chain:{id:string;symbol:string},txids:string[],read:(method:string,params:any[])=>Promise<any>,
):Promise<RecentActivity[]>{
 const ids=[...new Set(txids)].filter(id=>/^0x[0-9a-f]{64}$/i.test(id)).slice(0,50)
 if(!ids.length)return []
 const head=BigInt(await read('eth_blockNumber',[]))
 if(head<0n||head>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Invalid EVM head')
 const rows:RecentActivity[]=[]
 let next=0
 await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{
  while(next<ids.length){
   const txid=ids[next++]
   const receipt=await read('eth_getTransactionReceipt',[txid])
   if(receipt===null)continue
   if(!receipt||!['0x0','0x1',0,1].includes(receipt.status)||receipt.blockNumber==null)throw Error('Invalid EVM receipt')
   const block=BigInt(receipt.blockNumber)
   if(block<0n||block>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Invalid EVM receipt block')
   const confirmations=Number(head>=block?head-block+1n:1n)
   if(!Number.isSafeInteger(confirmations))throw Error('Invalid EVM confirmation count')
   rows.push({id:`receipt-${chain.id}-${txid}`,txid,chain:chain.symbol,chainId:chain.id,type:'send',source:'scan',status:Number(receipt.status)===0?'failed':'broadcast',createdAt:Date.now(),confirmations,blockHeight:Number(block)})
  }
 }))
 return rows
}
