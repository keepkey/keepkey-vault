import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import { utils as ethersUtils } from 'ethers'

import type { ClearSignAuditEvidence, ClearSignObservationDraft } from '../shared/types'
import { PROGRAM_REGISTRY } from './solana-instruction-decoder'
import { expandClearSignAuditDrafts } from './clearsign-observation'

const EIP1967_IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const EIP1967_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const SOLANA_IDL_API = 'https://idl-one.vercel.app/api/idl'
const MAX_IDL_BYTES = 1_000_000
const ERC7730_REGISTRY_RAW = 'https://raw.githubusercontent.com/ethereum/clear-signing-erc7730-registry/master/'
const ERC7730_INDEX = `${ERC7730_REGISTRY_RAW}index.calldata.json`
const ERC7730_EIP712_INDEX = `${ERC7730_REGISTRY_RAW}index.eip712.json`

function endpointLabel(endpoint: string): string {
  if (endpoint.startsWith('eip155:')) return endpoint
  try { return new URL(endpoint).origin } catch { return 'configured-provider' }
}

async function jsonRpc(endpoint: string, method: string, params: unknown[]): Promise<any> {
  if (endpoint.startsWith('eip155:')) {
    const [{ getPioneer }, { pioneerEvmRpc }] = await Promise.all([import('./pioneer'), import('./pioneer-evm')])
    return pioneerEvmRpc(await getPioneer(), endpoint, method, params)
  }
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(7_000),
  })
  if (!response.ok) throw new Error(`HTTP_${response.status}`)
  const payload: any = await response.json()
  if (payload.error) throw new Error(`RPC_${payload.error.code ?? 'ERROR'}`)
  return payload.result
}

function storageAddress(word: unknown): string | undefined {
  const value = String(word || '')
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0+$/.test(value)) return undefined
  const address = `0x${value.slice(-40)}`.toLowerCase()
  return /^0x[0-9a-f]{40}$/.test(address) ? address : undefined
}

function abiType(input: any): string {
  const type = String(input?.type || '')
  if (!type.startsWith('tuple')) return type
  const suffix = type.slice('tuple'.length)
  return `(${(input?.components || []).map(abiType).join(',')})${suffix}`
}

async function discoverSourcifyCandidates(
  chainId: number,
  addresses: string[],
  selector: string,
): Promise<NonNullable<ClearSignAuditEvidence['candidates']>> {
  if (!/^0x[0-9a-f]{8}$/.test(selector)) return []
  const candidates: NonNullable<ClearSignAuditEvidence['candidates']> = []
  for (const address of addresses) {
    const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address.toLowerCase()}?fields=abi,compilation.name`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(7_000) })
      if (!response.ok) continue
      const contract: any = await response.json()
      for (const entry of Array.isArray(contract?.abi) ? contract.abi : []) {
        if (entry?.type !== 'function' || !entry?.name) continue
        const signature = `${entry.name}(${(entry.inputs || []).map(abiType).join(',')})`
        if (ethersUtils.id(signature).slice(0, 10).toLowerCase() !== selector) continue
        candidates.push({
          source: 'sourcify', address: address.toLowerCase(), selectorOrDiscriminator: selector,
          name: String(entry.name), signature,
          inputs: (entry.inputs || []).map((input: any) => ({ name: String(input.name || ''), type: abiType(input) })),
          matchQuality: String(contract.runtimeMatch || contract.match || 'unknown'),
          verifiedAt: typeof contract.verifiedAt === 'string' ? contract.verifiedAt : undefined,
          provenance: url,
        })
      }
    } catch { /* absence or outage is a limitation, never a signing failure */ }
  }
  return candidates
}

async function boundedJson(url: string, maxBytes = MAX_IDL_BYTES): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(7_000) })
  if (!response.ok) throw new Error(`HTTP_${response.status}`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new Error('RESPONSE_TOO_LARGE')
  const text = await response.text()
  if (text.length > maxBytes) throw new Error('RESPONSE_TOO_LARGE')
  return JSON.parse(text)
}

async function discoverErc7730Candidates(
  chainId: number,
  contract: string,
  selector: string,
): Promise<{ candidates: NonNullable<ClearSignAuditEvidence['candidates']>; available: boolean }> {
  if (!/^0x[0-9a-f]{40}$/.test(contract) || !/^0x[0-9a-f]{8}$/.test(selector)) return { candidates: [], available: true }
  try {
    const index = await boundedJson(ERC7730_INDEX, 2_000_000)
    const path = index?.[`eip155:${chainId}:${contract}`]
    if (typeof path !== 'string' || !/^registry\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.json$/.test(path)) return { candidates: [], available: true }
    const url = `${ERC7730_REGISTRY_RAW}${path}`
    const descriptor = await boundedJson(url)
    if (descriptor?.$schema !== '../../specs/erc7730-v2.schema.json') return { candidates: [], available: true }
    const deployments = descriptor?.context?.contract?.deployments
    if (!Array.isArray(deployments) || !deployments.some((deployment: any) =>
      Number(deployment?.chainId) === chainId && String(deployment?.address || '').toLowerCase() === contract)) return { candidates: [], available: true }
    const formats = descriptor?.display?.formats
    if (!formats || typeof formats !== 'object' || Array.isArray(formats)) return { candidates: [], available: true }
    const candidates: NonNullable<ClearSignAuditEvidence['candidates']> = []
    const descriptorHash = createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')
    for (const fragmentText of Object.keys(formats)) {
      try {
        const fragment = ethersUtils.FunctionFragment.from(fragmentText)
        const signature = fragment.format(ethersUtils.FormatTypes.sighash)
        if (ethersUtils.id(signature).slice(0, 10).toLowerCase() !== selector) continue
        const display = formats[fragmentText]
        if (!display || typeof display !== 'object' || Array.isArray(display)) continue
        const rawFields = Array.isArray(display.fields) ? display.fields.slice(0, 32) : []
        candidates.push({
          source: 'erc7730-registry', address: contract, selectorOrDiscriminator: selector,
          name: fragment.name, signature,
          inputs: fragment.inputs.map(input => ({ name: input.name || '', type: input.format(ethersUtils.FormatTypes.sighash) })),
          erc7730Display: {
            intent: typeof display.intent === 'string' ? display.intent : '',
            interpolatedIntent: typeof display.interpolatedIntent === 'string' ? display.interpolatedIntent : undefined,
            hasIncludes: typeof descriptor.includes === 'string' || Array.isArray(descriptor.includes),
            requiredOrExcluded: Array.isArray(display.required) || Array.isArray(display.excluded),
            fieldsTruncated: Array.isArray(display.fields) && display.fields.length > 32,
            fields: rawFields.map((field: any) => ({
              path: typeof field?.path === 'string' ? field.path : undefined,
              label: typeof field?.label === 'string' ? field.label : undefined,
              format: typeof field?.format === 'string' ? field.format : undefined,
              hasParams: Boolean(field?.params && typeof field.params === 'object'),
              visible: typeof field?.visible === 'string' ? field.visible : field?.visible ? 'conditional' : undefined,
              encrypted: Boolean(field?.encryption),
            })),
          },
          matchQuality: 'erc7730-v2-active-registry',
          provenance: `${url}#schema=erc7730-v2&parsed-json-sha256=${descriptorHash}`,
        })
      } catch { /* malformed fragment cannot become a candidate */ }
    }
    return { candidates, available: true }
  } catch { return { candidates: [], available: false } }
}

async function discoverErc7730TypedDataCandidates(
  draft: ClearSignObservationDraft,
): Promise<{ candidates: NonNullable<ClearSignAuditEvidence['candidates']>; available: boolean }> {
  const chainId = Number(draft.shape.chainId)
  const contract = String(draft.shape.verifyingContract || '').toLowerCase()
  const primaryType = String(draft.shape.primaryType || '')
  const types = draft.shape.types as Record<string, Array<{ name: string; type: string }>> | undefined
  if (!Number.isSafeInteger(chainId) || !/^0x[0-9a-f]{40}$/.test(contract) || !primaryType || !types?.[primaryType]) {
    return { candidates: [], available: true }
  }
  try {
    const encoder = ethersUtils._TypedDataEncoder.from(types)
    const encodeType = encoder.encodeType(primaryType)
    const typeHash = ethersUtils.id(encodeType).toLowerCase()
    const index = await boundedJson(ERC7730_EIP712_INDEX, 4_000_000)
    const entries = index?.[`eip155:${chainId}:${contract}`]?.[primaryType]
    if (!Array.isArray(entries)) return { candidates: [], available: true }
    const matching = entries.filter((entry: any) => Array.isArray(entry?.encodeTypeHashes)
      && entry.encodeTypeHashes.some((hash: unknown) => String(hash).toLowerCase() === typeHash))
    const candidates: NonNullable<ClearSignAuditEvidence['candidates']> = []
    for (const entry of matching.slice(0, 8)) {
      const path = entry?.path
      if (typeof path !== 'string' || !/^registry\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.json$/.test(path)) continue
      const url = `${ERC7730_REGISTRY_RAW}${path}`
      const descriptor = await boundedJson(url)
      if (descriptor?.$schema !== '../../specs/erc7730-v2.schema.json') continue
      const formats = descriptor?.display?.formats
      if (!formats || typeof formats !== 'object' || Array.isArray(formats)) continue
      const formatKey = Object.keys(formats).find(key => ethersUtils.id(key).toLowerCase() === typeHash)
      if (!formatKey) continue
      const display: any = formats[formatKey]
      const rawFields = Array.isArray(display?.fields) ? display.fields.slice(0, 32) : []
      const descriptorHash = createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')
      candidates.push({
        source: 'erc7730-registry', address: contract, selectorOrDiscriminator: typeHash,
        name: primaryType, signature: encodeType, inputs: types[primaryType],
        erc7730Display: {
          intent: typeof display?.intent === 'string' ? display.intent : '',
          interpolatedIntent: typeof display?.interpolatedIntent === 'string' ? display.interpolatedIntent : undefined,
          hasIncludes: typeof descriptor.includes === 'string' || Array.isArray(descriptor.includes),
          requiredOrExcluded: Array.isArray(display?.required) || Array.isArray(display?.excluded),
          fieldsTruncated: Array.isArray(display?.fields) && display.fields.length > 32,
          fields: rawFields.map((field: any) => ({
            path: typeof field?.path === 'string' ? field.path : undefined,
            label: typeof field?.label === 'string' ? field.label : undefined,
            format: typeof field?.format === 'string' ? field.format : undefined,
            hasParams: Boolean(field?.params && typeof field.params === 'object'),
            visible: typeof field?.visible === 'string' ? field.visible : field?.visible ? 'conditional' : undefined,
            encrypted: Boolean(field?.encryption),
          })),
        },
        matchQuality: 'erc7730-v2-active-registry-eip712',
        provenance: `${url}#encodeTypeHash=${typeHash}&parsed-json-sha256=${descriptorHash}`,
      })
    }
    return { candidates, available: true }
  } catch { return { candidates: [], available: false } }
}

/** Code identity of a contract as deployed right now: its code hash plus any
 * EIP-1967 implementation/beacon (or implementation()) target. The audit
 * records this, and signing re-measures it — an upgrade or redeploy changes it. */
export async function snapshotEvmIdentities(contract: string, endpoint: string) {
  const [block, code, implementationWord, beaconWord] = await Promise.all([
    jsonRpc(endpoint, 'eth_blockNumber', []),
    jsonRpc(endpoint, 'eth_getCode', [contract, 'latest']),
    jsonRpc(endpoint, 'eth_getStorageAt', [contract, EIP1967_IMPLEMENTATION, 'latest']).catch(() => undefined),
    jsonRpc(endpoint, 'eth_getStorageAt', [contract, EIP1967_BEACON, 'latest']).catch(() => undefined),
  ])
  const identities: ClearSignAuditEvidence['identities'] = [{
    address: contract, role: 'contract',
    codeHash: typeof code === 'string' && code !== '0x' ? ethersUtils.keccak256(code) : undefined,
  }]
  const proxyTargets = [
    { address: storageAddress(implementationWord), role: 'implementation' as const },
    { address: storageAddress(beaconWord), role: 'beacon' as const },
  ].filter((entry): entry is { address: string; role: 'implementation' | 'beacon' } => Boolean(entry.address))
  if (!proxyTargets.some((entry) => entry.role === 'implementation')) {
    try {
      const result = await jsonRpc(endpoint, 'eth_call', [{ to: contract, data: '0x5c60da1b' }, block])
      const address = storageAddress(result)
      if (address && address !== contract) proxyTargets.push({ address, role: 'implementation' })
    } catch { /* not an implementation() proxy */ }
  }
  for (const target of proxyTargets) {
    const targetCode = await jsonRpc(endpoint, 'eth_getCode', [target.address, block])
    identities.push({
      address: target.address, role: target.role,
      codeHash: typeof targetCode === 'string' && targetCode !== '0x' ? ethersUtils.keccak256(targetCode) : undefined,
    })
  }
  return { block, code, identities }
}

export async function auditEvmIdentity(draft: ClearSignObservationDraft, endpoint: string): Promise<ClearSignAuditEvidence> {
  const contract = String(draft.shape.contract || '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(contract)) throw new Error('NO_CONTRACT_IDENTITY')
  const { block, code, identities } = await snapshotEvmIdentities(contract, endpoint)
  const limitations = [
    'Code identity does not prove a human-readable definition is correct.',
    'Non-EIP-1967 proxies and runtime-created targets may require execution tracing.',
  ]
  if (code === '0x') limitations.unshift('The target had no deployed bytecode at the audited block.')
  const selector = String(draft.shape.selector || '').toLowerCase()
  const chainId = Number(draft.shape.chainId || 1)
  const [sourcify, erc7730Discovery] = await Promise.all([
    discoverSourcifyCandidates(chainId, identities.map((entry) => entry.address), selector),
    discoverErc7730Candidates(chainId, contract, selector),
  ])
  const erc7730 = erc7730Discovery.candidates
  const candidates = [...sourcify, ...erc7730]
  if (!sourcify.length) limitations.push('No selector-matching verified Sourcify ABI was found for the resolved identities.')
  else limitations.push('Verified source establishes encoding provenance, not transaction effects or display safety.')
  if (erc7730.length) limitations.push('ERC-7730 registry context and selector matched, but its semantics, includes, tests, code identity, and firmware rendering still require promotion review.')
  else if (!erc7730Discovery.available) limitations.push('ERC-7730 registry discovery was unavailable; absence of a candidate is not evidence that no descriptor exists.')
  else limitations.push('No active-v2 ERC-7730 registry descriptor matched the exact chain, contract, and selector.')
  return { version: 1, auditedAt: Date.now(), chain: 'Ethereum', endpoint: endpointLabel(endpoint), stateReference: String(block), identities, candidates, limitations }
}

export async function auditEvmTypedDataIdentity(draft: ClearSignObservationDraft, endpoint: string): Promise<ClearSignAuditEvidence> {
  if (draft.requestKind !== 'evm-typed-data') throw new Error('NOT_EIP712_SHAPE')
  const verifyingContract = String(draft.shape.verifyingContract || '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(verifyingContract)) throw new Error('NO_VERIFYING_CONTRACT_IDENTITY')
  const identityDraft: ClearSignObservationDraft = {
    ...draft,
    shape: { chainId: draft.shape.chainId, contract: verifyingContract, selector: 'none', calldataLength: 0 },
  }
  const [identityEvidence, discovery] = await Promise.all([
    auditEvmIdentity(identityDraft, endpoint),
    discoverErc7730TypedDataCandidates(draft),
  ])
  const limitations = identityEvidence.limitations.filter(item =>
    !item.includes('selector-matching') && !item.includes('active-v2 ERC-7730 registry descriptor'))
  if (discovery.candidates.length) limitations.push('ERC-7730 EIP-712 context, primary type, and encodeTypeHash matched; display semantics and device rendering still require review and a typed-data-capable firmware format.')
  else if (!discovery.available) limitations.push('ERC-7730 EIP-712 registry discovery was unavailable; absence of a candidate is not evidence that no descriptor exists.')
  else limitations.push('No active-v2 ERC-7730 EIP-712 descriptor matched the exact chain, verifying contract, primary type, and encodeTypeHash.')
  return { ...identityEvidence, candidates: discovery.candidates, limitations }
}

function accountBytes(value: any): Buffer {
  const encoded = Array.isArray(value?.data) ? value.data[0] : value?.data
  if (typeof encoded !== 'string') throw new Error('ACCOUNT_DATA_UNAVAILABLE')
  return Buffer.from(encoded, 'base64')
}

function anchorType(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return 'unknown' }
}

function flattenAnchorAccounts(accounts: unknown[], prefix = ''): Array<{ name: string; writable?: boolean; signer?: boolean }> {
  const result: Array<{ name: string; writable?: boolean; signer?: boolean }> = []
  for (const raw of accounts) {
    const account: any = raw
    if (!account || typeof account.name !== 'string') continue
    const name = prefix ? `${prefix}.${account.name}` : account.name
    if (Array.isArray(account.accounts)) result.push(...flattenAnchorAccounts(account.accounts, name))
    else result.push({
      name,
      writable: Boolean(account.writable ?? account.isMut),
      signer: Boolean(account.signer ?? account.isSigner),
    })
  }
  return result
}

function anchorDiscriminator(instruction: any): string | undefined {
  if (Array.isArray(instruction?.discriminator)
    && instruction.discriminator.length === 8
    && instruction.discriminator.every((value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255)) {
    return Buffer.from(instruction.discriminator).toString('hex')
  }
  if (typeof instruction?.name !== 'string' || !instruction.name) return undefined
  return createHash('sha256').update(`global:${instruction.name}`).digest('hex').slice(0, 16)
}

/** PMP-first, legacy-Anchor-fallback discovery. This is untrusted semantics:
 * exact discriminator matching makes it useful for triage but never P4. */
async function discoverAnchorIdlCandidates(
  program: string,
  discriminators: string[],
  endpoint: string,
): Promise<NonNullable<ClearSignAuditEvidence['candidates']>> {
  const cluster = /devnet/i.test(endpoint) ? 'devnet' : 'mainnet-beta'
  const url = `${SOLANA_IDL_API}?programId=${encodeURIComponent(program)}&cluster=${cluster}`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(7_000) })
    if (!response.ok) return []
    const text = await response.text()
    if (text.length > MAX_IDL_BYTES) return []
    const envelope: any = JSON.parse(text)
    const content = typeof envelope?.content === 'string' ? envelope.content : envelope?.content
    const idl: any = typeof content === 'string' ? JSON.parse(content) : content
    if (!idl || !Array.isArray(idl.instructions)) return []
    const wanted = new Set(discriminators.map(value => value.toLowerCase()).filter(value => /^[0-9a-f]{16}$/.test(value)))
    const candidates: NonNullable<ClearSignAuditEvidence['candidates']> = []
    for (const instruction of idl.instructions) {
      const discriminator = anchorDiscriminator(instruction)
      if (!discriminator || !wanted.has(discriminator)) continue
      const inputs = (Array.isArray(instruction.args) ? instruction.args : []).map((arg: any) => ({
        name: String(arg?.name || ''), type: anchorType(arg?.type),
      }))
      candidates.push({
        source: 'anchor-idl', address: program, selectorOrDiscriminator: discriminator,
        name: String(instruction.name),
        signature: `${instruction.name}(${inputs.map(input => input.type).join(',')})`,
        inputs, accounts: flattenAnchorAccounts(Array.isArray(instruction.accounts) ? instruction.accounts : []),
        matchQuality: envelope.type === 'pmp' ? 'canonical-program-metadata' : `legacy-${String(envelope.type || 'anchor')}`,
        provenance: `${url}#metadata=${encodeURIComponent(String(envelope.address || 'unknown'))}&authority=${encodeURIComponent(String(envelope.authority || 'unknown'))}`,
      })
    }
    return candidates
  } catch { return [] }
}

export async function auditSolanaIdentity(draft: ClearSignObservationDraft, endpoint: string): Promise<ClearSignAuditEvidence> {
  const components = Array.isArray(draft.shape.components) ? draft.shape.components as Array<Record<string, unknown>> : []
  const programs = [...new Set(components.map((entry) => String(entry.program || '')).filter((value) => {
    try { return bs58.decode(value).length === 32 } catch { return false }
  }))]
  if (!programs.length) throw new Error('NO_PROGRAM_IDENTITY')
  const slot = await jsonRpc(endpoint, 'getSlot', [{ commitment: 'confirmed' }])
  const identities: ClearSignAuditEvidence['identities'] = []
  const limitations = ['Program identity does not prove a human-readable instruction definition is correct.']
  for (const program of programs) {
    const response = await jsonRpc(endpoint, 'getAccountInfo', [program, { encoding: 'base64', commitment: 'confirmed' }])
    const value = response?.value
    if (!value) {
      identities.push({ address: program, role: 'program', executable: false })
      continue
    }
    const data = accountBytes(value)
    identities.push({ address: program, role: 'program', owner: value.owner, executable: value.executable === true, codeHash: createHash('sha256').update(data).digest('hex') })
    if (value.owner !== UPGRADEABLE_LOADER || data.length < 36 || data.readUInt32LE(0) !== 2) continue
    const programData = bs58.encode(data.subarray(4, 36))
    const programDataResponse = await jsonRpc(endpoint, 'getAccountInfo', [programData, { encoding: 'base64', commitment: 'confirmed' }])
    const programDataValue = programDataResponse?.value
    if (!programDataValue) continue
    const programDataBytes = accountBytes(programDataValue)
    let deployedSlot: string | undefined
    let upgradeAuthority: string | undefined
    if (programDataBytes.length >= 13 && programDataBytes.readUInt32LE(0) === 3) {
      deployedSlot = programDataBytes.readBigUInt64LE(4).toString()
      if (programDataBytes[12] === 1 && programDataBytes.length >= 45) upgradeAuthority = bs58.encode(programDataBytes.subarray(13, 45))
    }
    identities.push({
      address: programData, role: 'program-data', owner: programDataValue.owner,
      executable: programDataValue.executable === true,
      codeHash: createHash('sha256').update(programDataBytes).digest('hex'),
      deployedSlot, upgradeAuthority,
    })
    if (upgradeAuthority) limitations.push(`Program ${program} remains upgradeable.`)
  }
  const candidates: NonNullable<ClearSignAuditEvidence['candidates']> = []
  const idlCandidates = await Promise.all(programs.map(async (program) => {
    const discriminators = components
      .filter(component => String(component.program || '') === program)
      .map(component => String(component.prefix8 || '').toLowerCase())
    return discoverAnchorIdlCandidates(program, discriminators, endpoint)
  }))
  candidates.push(...idlCandidates.flat())
  for (const component of components) {
    const program = String(component.program || '')
    const registry = PROGRAM_REGISTRY.programs[program]
    if (!registry?.instructions) continue
    const encoding = registry.discriminator?.encoding || 'none'
    const discriminator = encoding === 'u8' ? String(component.prefix1 || '')
      : encoding === 'u32-le' ? String(component.prefix8 || '').slice(0, 8)
        : encoding === 'anchor' ? String(component.prefix8 || '') : ''
    const instruction = registry.instructions[discriminator]
    if (!instruction) continue
    if (candidates.some((candidate) => candidate.address === program && candidate.selectorOrDiscriminator === discriminator)) continue
    candidates.push({
      source: 'program-registry', address: program, selectorOrDiscriminator: discriminator,
      name: instruction.name,
      inputs: (instruction.args || []).map((arg) => ({ name: arg.name, type: arg.type })),
      accounts: (instruction.accounts || []).map((name) => ({ name })),
      provenance: registry.website || '@pioneer-platform/pioneer-discovery + Vault local registry',
    })
  }
  if (candidates.some(candidate => candidate.source === 'anchor-idl')) limitations.push('On-chain IDL labels are audit candidates; publisher authority, byte coverage, effects, and display safety still require independent review.')
  if (candidates.some(candidate => candidate.source === 'program-registry')) limitations.push('Registry labels are audit candidates; their provenance and byte coverage still require independent review.')
  if (!candidates.length) limitations.push('No discriminator-matching Program Metadata, legacy Anchor IDL, or local registry entry was found.')
  return { version: 1, auditedAt: Date.now(), chain: 'Solana', endpoint: endpointLabel(endpoint), stateReference: String(slot), identities, candidates, limitations }
}

/** Enrich an unknown shape with reproducible public-chain identity evidence. Never promotes coverage. */
export async function auditUnknownClearSignShape(
  draft: ClearSignObservationDraft,
  endpoints: { evm?: string; solana?: string },
): Promise<void> {
  // Keep the read-only evidence adapters independent from application/DB
  // startup. The persistence layer is needed only by this queue entry point.
  const { claimClearSignAuditJob, completeClearSignAuditJob, failClearSignAuditJob } = await import('./db')
  for (const auditDraft of expandClearSignAuditDrafts(draft)) {
    if (!claimClearSignAuditJob(auditDraft.shapeKey)) continue
    try {
      const evidence = auditDraft.chain === 'Ethereum'
        ? auditDraft.requestKind === 'evm-typed-data'
          ? await auditEvmTypedDataIdentity(auditDraft, endpoints.evm || `eip155:${auditDraft.shape.chainId || 1}`)
          : await auditEvmIdentity(auditDraft, endpoints.evm || `eip155:${auditDraft.shape.chainId || 1}`)
        : await auditSolanaIdentity(auditDraft, endpoints.solana || 'https://api.mainnet-beta.solana.com')
      completeClearSignAuditJob(auditDraft.shapeKey, evidence)
    } catch (error: any) {
      const errorClass = String(error?.message || 'AUDIT_FAILED').replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)
      failClearSignAuditJob(auditDraft.shapeKey, errorClass)
    }
  }
}
