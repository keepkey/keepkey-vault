import type { ClearSignProtectionCaseStudy } from '../shared/types'

const EVM_TX = '0x686f1cfeb70836bd052e79686393834fc5afb935b9f8badcd1e42bfc94b5870b'
const SOLANA_TX = '5ikNh4NekadNDnioJDa52vjdzdjRS5tAJ4w1QNi8wVorZJ6wGuRxLdwUFBbUeuXPxhF3mLhVBfGDGfXCJrt6Aiyz'
const RELAY_SOLANA_PROGRAM = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

async function rpc(endpoint: string, method: string, params: unknown[], fetcher: typeof fetch): Promise<any> {
  const response = await fetcher(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(7_000),
  })
  if (!response.ok) throw new Error(`HTTP_${response.status}`)
  const body: any = await response.json()
  if (body.error) throw new Error(`RPC_${body.error.code ?? 'ERROR'}`)
  if (!body.result) throw new Error('TRANSACTION_NOT_FOUND')
  return body.result
}

function unavailable(id: string, chain: 'Ethereum' | 'Solana', title: string, transactionId: string, source: string, error: unknown): ClearSignProtectionCaseStudy {
  return {
    id, chain, title, transactionId, status: 'unavailable', protectionLevel: 'P1', facts: [], protections: [],
    limits: [`Public-chain verification unavailable: ${String((error as any)?.message || error).slice(0, 120)}`],
    source, checkedAt: Date.now(),
  }
}

async function evmCase(endpoint: string, fetcher: typeof fetch): Promise<ClearSignProtectionCaseStudy> {
  const source = endpoint
  try {
    const tx = await rpc(endpoint, 'eth_getTransactionByHash', [EVM_TX], fetcher)
    let receipt: any
    try { receipt = await rpc(endpoint, 'eth_getTransactionReceipt', [EVM_TX], fetcher) }
    catch {
      const receipts = await rpc(endpoint, 'eth_getBlockReceipts', [tx.blockNumber], fetcher)
      receipt = Array.isArray(receipts) ? receipts.find((entry: any) => entry.transactionHash?.toLowerCase() === EVM_TX) : undefined
    }
    const input = String(tx.input || '0x')
    const inputBytes = Math.max(0, (input.length - 2) / 2)
    const value = BigInt(tx.value || '0x0')
    const mined = /^0x[0-9a-f]+$/i.test(String(tx.blockNumber || ''))
    const signerTopic = `0x${String(tx.from || '').replace(/^0x/, '').padStart(64, '0')}`.toLowerCase()
    const received = (receipt?.logs || []).filter((log: any) => log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC
      && log.topics?.[2]?.toLowerCase() === signerTopic).map((log: any) => ({
        token: String(log.address || '').toLowerCase(), amount: BigInt(log.data || '0x0').toString(),
      }))
    const invariant = tx.hash?.toLowerCase() === EVM_TX && receipt?.status === '0x1'
      && receipt?.blockNumber === tx.blockNumber && /^0x[0-9a-f]{40}$/i.test(String(tx.to || '')) && inputBytes > 260
    return {
      id: 'relay-evm-dynamic-router', chain: 'Ethereum', title: 'Completed Relay ETH → USDT router call',
      transactionId: EVM_TX, status: invariant && mined ? 'verified' : 'contradicted',
      stateReference: tx.blockNumber, observedAt: tx.blockTimestamp ? Number(BigInt(tx.blockTimestamp)) * 1000 : undefined,
      protectionLevel: 'P3',
      facts: [
        `The signed transaction sent ${value.toString()} wei to ${String(tx.to).toLowerCase()}.`,
        `Selector ${input.slice(0, 10).toLowerCase()} carried ${inputBytes} bytes of dynamic router calldata.`,
        `The execution receipt reports success with ${BigInt(receipt?.gasUsed || 0).toString()} gas used.`,
        ...(received.length ? [`Receipt logs show ${received.map((entry: any) => `${entry.amount} raw units of ${entry.token}`).join(', ')} returned to the signer.`] : []),
      ],
      protections: [
        'Pre-sign execution simulation can expose native/token balance decreases, approvals, recipients, and nested calls.',
        'A changed selector, target, value, or simulated effect produces a different report before device approval.',
      ],
      limits: [
        'This calldata exceeds the firmware v2 eight-word format and must not be labeled authenticated ClearSign.',
        'Simulation is state-dependent and cannot authenticate off-chain quote promises such as minimum output.',
      ],
      source, checkedAt: Date.now(),
    }
  } catch (error) { return unavailable('relay-evm-dynamic-router', 'Ethereum', 'Completed Relay ETH → USDT router call', EVM_TX, source, error) }
}

async function solanaCase(endpoint: string, fetcher: typeof fetch): Promise<ClearSignProtectionCaseStudy> {
  const source = endpoint
  try {
    const result = await rpc(endpoint, 'getTransaction', [SOLANA_TX, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }], fetcher)
    const outer = result.transaction?.message?.instructions || []
    const relay = outer.find((ix: any) => ix.programId === RELAY_SOLANA_PROGRAM)
    const inner = (result.meta?.innerInstructions || []).flatMap((entry: any) => entry.instructions || [])
    const transfer = inner.find((ix: any) => ix.program === 'system' && ix.parsed?.type === 'transfer')
    const lamports = Number(transfer?.parsed?.info?.lamports)
    const success = result.meta?.err == null
    const signatureMatches = result.transaction?.signatures?.[0] === SOLANA_TX
    const depositLog = (result.meta?.logMessages || []).includes('Program log: Instruction: DepositNative')
    const invariant = success && signatureMatches && relay && depositLog && Number.isSafeInteger(lamports) && lamports > 0
    return {
      id: 'relay-solana-deposit-native', chain: 'Solana', title: 'Completed Relay SOL → ETH deposit',
      transactionId: SOLANA_TX, status: invariant ? 'verified' : 'contradicted', stateReference: String(result.slot || ''),
      observedAt: result.blockTime ? Number(result.blockTime) * 1000 : undefined,
      protectionLevel: 'P4',
      facts: [
        `Relay depositNative invoked the System Program by CPI and transferred ${Number.isFinite(lamports) ? lamports : 'unknown'} lamports.`,
        `The transaction paid ${String(result.meta?.fee ?? 'unknown')} lamports in fees and completed without a program error.`,
      ],
      protections: [
        'KKSOLSC1 authenticates the Relay program, discriminator, amount, order ID, and labeled vault account on-device.',
        'Exact byte coverage rejects a truncated instruction, changed discriminator, or appended hidden fields.',
        'Simulation independently reveals the inner System Program transfer instead of trusting the outer label.',
      ],
      limits: [
        'The Solana deposit bytes do not contain or authenticate the promised ETH output amount, destination-chain execution, or minimum received.',
        'P4 authenticates this instruction description; it is not an end-to-end guarantee for the cross-chain swap.',
      ],
      source, checkedAt: Date.now(),
    }
  } catch (error) { return unavailable('relay-solana-deposit-native', 'Solana', 'Completed Relay SOL → ETH deposit', SOLANA_TX, source, error) }
}

/** Re-fetch public transactions so the case studies are evidence, not screenshots or assertions. */
export async function getClearSignProtectionCaseStudies(options: {
  evmEndpoint?: string
  solanaEndpoint?: string
  fetcher?: typeof fetch
} = {}): Promise<ClearSignProtectionCaseStudy[]> {
  const fetcher = options.fetcher || fetch
  const evmEndpoints = options.evmEndpoint
    ? [options.evmEndpoint]
    : ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org']
  const evmPromise = (async () => {
    let last: ClearSignProtectionCaseStudy | undefined
    for (const endpoint of evmEndpoints) {
      last = await evmCase(endpoint, fetcher)
      if (last.status !== 'unavailable') return last
    }
    return last!
  })()
  return Promise.all([
    evmPromise,
    solanaCase(options.solanaEndpoint || 'https://api.mainnet-beta.solana.com', fetcher),
  ])
}
