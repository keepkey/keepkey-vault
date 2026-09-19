import { describe, expect, it } from 'bun:test'
import { ALT_PROGRAM_ID } from '../../src/bun/solana-alt'
import { createResilientSolanaAltFetcher, solanaRpcEndpoints, solanaRpcHealth } from './solana-rpc'

const env = { CLEARSIGN_SOLANA_RPC_ENDPOINTS: 'https://primary.example,https://backup.example' }
const table = Buffer.alloc(88); table.writeUInt32LE(1); table.fill(7,56)
const reply = () => Response.json({ result: { value: [{ owner: ALT_PROGRAM_ID, data: [table.toString('base64'),'base64'] }] } })

describe('server-side Solana RPC failover', () => {
  it('recovers from a blocked primary and reports degraded redundancy', async () => {
    const urls: string[]=[]
    const fetcher = (async (url: any) => {urls.push(String(url));return urls.length===1 ? new Response('',{status:403}) : reply()}) as typeof fetch
    const accounts=await createResilientSolanaAltFetcher(env,fetcher)(['table'])
    expect(urls).toEqual(['https://primary.example','https://backup.example'])
    expect(accounts[0]?.data).toEqual(table)
    expect((await solanaRpcHealth(env)).status).toBe('degraded')
  })
  it('bounds a hung response body and moves to the backup', async () => {
    let calls=0
    const fetcher=(async()=> ++calls===1 ? {ok:true,json:()=>new Promise(()=>{})} : reply()) as typeof fetch
    const result=await createResilientSolanaAltFetcher(env,fetcher,15)(['table'])
    expect(calls).toBe(2);expect(result).toHaveLength(1)
  })
  it('rejects unowned or malformed account data, including after failover', async () => {
    const fetcher=(async()=>Response.json({result:{value:[{owner:'attacker',data:[table.toString('base64'),'base64']}]}})) as typeof fetch
    await expect(createResilientSolanaAltFetcher(env,fetcher)(['table'])).rejects.toThrow('account RPC is unavailable')
    expect((await solanaRpcHealth(env)).status).toBe('unavailable')
  })
  it('fails with a bounded unavailable error when all providers fail', async () => {
    const fetcher=(async()=>{throw new Error('secret-bearing RPC URL must not reach the client')}) as typeof fetch
    await expect(createResilientSolanaAltFetcher(env,fetcher)(['table'])).rejects.toThrow('Please retry shortly')
  })
  it('does not manufacture providers or accept credentials in URL authority', () => {
    expect(()=>solanaRpcEndpoints({})).toThrow()
    expect(()=>solanaRpcEndpoints({CLEARSIGN_SOLANA_RPC_ENDPOINT:'https://user:password@rpc.example'})).toThrow()
    expect(solanaRpcEndpoints({CLEARSIGN_SOLANA_RPC_ENDPOINT:'https://operator.example/path'})).toEqual(['https://operator.example/path'])
  })
})
