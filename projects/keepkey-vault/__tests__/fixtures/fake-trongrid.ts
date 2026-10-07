/** Fake TronGrid that encodes REAL raw_data protobuf from each request, so the
 * builder's decode-and-compare gate runs against genuine bytes. `tamper` lets a
 * test make TronGrid lie about what it built. */
import protobuf from 'protobufjs/light'
import bs58 from 'bs58'

const w = () => new protobuf.Writer()
const addr = (a: string) => Buffer.from(bs58.decode(a)).subarray(0, 21)
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

function rawTx(type: number, url: string, payload: Uint8Array, memo?: string, feeLimit?: number): string {
  const any = w().uint32(10).string(`type.googleapis.com/protocol.${url}`).uint32(18).bytes(payload).finish()
  const contract = w().uint32(8).uint32(type).uint32(18).bytes(any).finish()
  const top = w()
  if (memo) top.uint32(82).bytes(Buffer.from(memo))
  top.uint32(90).bytes(contract)
  if (feeLimit !== undefined) top.uint32(144).uint64(feeLimit)
  return Buffer.from(top.finish()).toString('hex')
}

export interface FakeTronGridOpts {
  decimals?: number
  balanceSun?: number
  tokenBalance?: bigint
  tamper?: (req: any, path: string) => any
}

export function fakeTronGrid(opts: FakeTronGridOpts = {}) {
  const requests: Record<string, any[]> = {}
  const handler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace('/wallet/', '')
    const req0 = init?.body ? JSON.parse(String(init.body)) : {}
    ;(requests[path] ??= []).push(req0)
    const req = opts.tamper ? opts.tamper({ ...req0 }, path) : req0
    switch (path) {
      case 'getaccount': return json({ balance: opts.balanceSun ?? 0 })
      case 'getchainparameters': return json({ chainParameter: [{ key: 'getEnergyFee', value: 100 }] })
      case 'triggerconstantcontract':
        if (req.function_selector === 'decimals()') return json({ constant_result: [(opts.decimals ?? 6).toString(16).padStart(64, '0')] })
        if (req.function_selector === 'balanceOf(address)') return json({ constant_result: [(opts.tokenBalance ?? 0n).toString(16).padStart(64, '0')] })
        return json({ energy_used: 65_000 })
      case 'createtransaction': {
        const payload = w().uint32(10).bytes(addr(req.owner_address)).uint32(18).bytes(addr(req.to_address))
          .uint32(24).uint64(req.amount).finish()
        return json({ txID: 'native', raw_data: {}, raw_data_hex: rawTx(1, 'TransferContract', payload, req.extra_data) })
      }
      case 'triggersmartcontract': {
        const data = Buffer.from('a9059cbb' + req.parameter, 'hex')
        const payload = w().uint32(10).bytes(addr(req.owner_address)).uint32(18).bytes(addr(req.contract_address))
          .uint32(34).bytes(data).finish()
        return json({ transaction: { txID: 'trc20', raw_data: {}, raw_data_hex: rawTx(31, 'TriggerSmartContract', payload, undefined, req.fee_limit) } })
      }
    }
    throw new Error(`unexpected fetch: ${path}`)
  }) as typeof fetch
  return { handler, requests }
}
