import { createHash } from 'node:crypto'

import type { ClearSignMutationKind, ClearSignPromotionBundle } from '../shared/types'

type Fixture = ClearSignPromotionBundle['fixtures'][number]

export interface ClearSignFixtureMutationVector {
  id: string
  kind: ClearSignMutationKind
  payloadHex: string
  context: Record<string, unknown>
  fixtureHash: string
  expected: 'reject' | 'different-display'
}

export interface ClearSignFixturePlan {
  version: 1
  /** Raw vectors are deliberately ephemeral: callers must not persist this plan. */
  retention: 'transient-operator-fixture'
  positiveFixture: Fixture
  positiveVector: { payloadHex: string; context: Record<string, unknown>; fixtureHash: string }
  mutations: ClearSignFixtureMutationVector[]
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizePayload(payloadHex: string): Buffer {
  const clean = payloadHex.replace(/^0x/i, '')
  if (!clean || clean.length % 2 || !/^[0-9a-f]+$/i.test(clean)) throw new Error('fixture payload must be non-empty, whole-byte hex')
  if (clean.length > 65_536) throw new Error('fixture payload exceeds 32 KiB')
  return Buffer.from(clean, 'hex')
}

function flip(bytes: Buffer, index: number): Buffer {
  const result = Buffer.from(bytes)
  result[index] ^= 1
  return result
}

function mutation(id: string, kind: ClearSignMutationKind, payload: Buffer, context: Record<string, unknown>, expected: 'reject' | 'different-display'): ClearSignFixtureMutationVector {
  const payloadHex = `0x${payload.toString('hex')}`
  return {
    id, kind, payloadHex, context, expected,
    fixtureHash: digest(canonical({ domain: 'KEEPKEY_CLEARSIGN_MUTATION_V1', kind, payloadHex, context })),
  }
}

/**
 * Builds reproducible device-oracle inputs from an explicitly opted-in or
 * operator-produced fixture. Nothing here writes to the database. Promotion
 * bundles retain only the returned hashes and the independently captured
 * device transcript.
 */
export function createClearSignFixturePlan(input: {
  chain: 'Ethereum' | 'Solana'
  payloadHex: string
  transactionFingerprint: string
  selectorOrDiscriminator: string
  decodedFields: unknown
  effects: unknown
  provenance: Fixture['provenance']
  context: Record<string, unknown>
}): ClearSignFixturePlan {
  const payload = normalizePayload(input.payloadHex)
  const prefix = normalizePayload(input.selectorOrDiscriminator)
  if (prefix.length >= payload.length || !payload.subarray(0, prefix.length).equals(prefix)) {
    throw new Error('fixture payload does not begin with the audited selector or discriminator')
  }
  const transactionFingerprint = input.transactionFingerprint.replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(transactionFingerprint)) throw new Error('transaction fingerprint must be 32-byte hex')

  const positiveFixture: Fixture = {
    transactionFingerprint,
    payloadHash: digest(payload),
    decodedFieldsHash: digest(canonical(input.decodedFields)),
    effectsHash: digest(canonical(input.effects)),
    provenance: input.provenance,
  }
  const mutations: ClearSignFixtureMutationVector[] = [
    mutation('truncate-last-byte', 'truncation', payload.subarray(0, payload.length - 1), input.context, 'reject'),
    mutation('change-selector-or-discriminator', 'selector-or-discriminator', flip(payload, 0), input.context, 'reject'),
    mutation('change-last-field-byte', 'field-boundary', flip(payload, payload.length - 1), input.context, 'different-display'),
  ]

  if (input.chain === 'Ethereum') {
    const chainId = Number(input.context.chainId)
    const contract = String(input.context.contract || '').toLowerCase()
    if (!Number.isSafeInteger(chainId) || chainId < 1 || !/^0x[0-9a-f]{40}$/.test(contract)) {
      throw new Error('EVM fixture context requires a positive chainId and contract address')
    }
    const changedContract = `${contract.slice(0, -1)}${contract.endsWith('0') ? '1' : '0'}`
    mutations.push(mutation('change-chain-or-contract', 'chain-or-contract', payload, {
      ...input.context, chainId: chainId === Number.MAX_SAFE_INTEGER ? chainId - 1 : chainId + 1, contract: changedContract,
    }, 'reject'))
  } else {
    const privileges = input.context.accountPrivileges
    if (!Array.isArray(privileges) || !privileges.length || !privileges.every(value => value && typeof value === 'object')) {
      throw new Error('Solana fixture context requires accountPrivileges')
    }
    const changed = privileges.map((value, index) => index === 0
      ? { ...(value as Record<string, unknown>), writable: !Boolean((value as Record<string, unknown>).writable) }
      : value)
    mutations.push(mutation('change-account-privilege', 'account-privilege', payload, {
      ...input.context, accountPrivileges: changed,
    }, 'reject'))
  }
  const normalizedPayloadHex = `0x${payload.toString('hex')}`
  return {
    version: 1, retention: 'transient-operator-fixture', positiveFixture,
    positiveVector: {
      payloadHex: normalizedPayloadHex, context: input.context,
      fixtureHash: digest(canonical({ domain: 'KEEPKEY_CLEARSIGN_POSITIVE_V1', payloadHex: normalizedPayloadHex, context: input.context })),
    },
    mutations,
  }
}
