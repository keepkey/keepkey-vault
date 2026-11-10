import {expect,test} from 'bun:test'
import {readEvmConfirmationRows} from '../src/bun/evm-confirmation-watch'
const txid='0x'+'1'.repeat(64)
test('pending confirmation tracking uses only receipt/head RPC and preserves confirmation targets',async()=>{
 const calls:string[]=[]
 const rows=await readEvmConfirmationRows({id:'ethereum',symbol:'ETH'},[txid,txid],async(method)=>{
  calls.push(method)
  return method==='eth_blockNumber'?'0x70':{status:'0x1',blockNumber:'0x65'}
 })
 expect(calls).toEqual(['eth_blockNumber','eth_getTransactionReceipt'])
 expect(rows[0]).toMatchObject({txid,confirmations:12,blockHeight:101})
})
test('unmined and malformed receipts cannot be reported as confirmed',async()=>{
 expect(await readEvmConfirmationRows({id:'ethereum',symbol:'ETH'},[txid],async(method)=>method==='eth_blockNumber'?'0x70':null)).toEqual([])
 await expect(readEvmConfirmationRows({id:'ethereum',symbol:'ETH'},[txid],async(method)=>method==='eth_blockNumber'?'0x70':{})).rejects.toThrow('Invalid')
})
