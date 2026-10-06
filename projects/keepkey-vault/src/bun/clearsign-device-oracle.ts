import { createHash } from 'node:crypto'

import type { ClearSignMutationKind, ClearSignPromotionBundle } from '../shared/types'
import type { ClearSignFixturePlan } from './clearsign-fixture-plan'

export interface ClearSignOracleVectorResult {
  outcome: 'displayed' | 'rejected' | 'failed'
  /** Hash of the ordered device screens, never host-decoded labels. */
  displayHash?: string
  errorClass?: string
}

export type ClearSignOracleExecutor = (vector: {
  id: string
  kind: 'positive' | ClearSignMutationKind
  payloadHex: string
  context: Record<string, unknown>
}) => Promise<ClearSignOracleVectorResult>

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')
}

/**
 * Runs a fixture plan against a real transport supplied by Vault, the emulator,
 * or a hardware harness. This module judges evidence but never substitutes a
 * host decode for the device's ordered-screen digest.
 */
export async function runClearSignDeviceOracle(input: {
  plan: ClearSignFixturePlan
  firmwareVersion: string
  artifactHash: string
  execute: ClearSignOracleExecutor
}): Promise<{
  deviceOracle: ClearSignPromotionBundle['deviceOracle']
  mutations: ClearSignPromotionBundle['mutations']
  transcript: { version: 1; firmwareVersion: string; artifactHash: string; entries: Array<Record<string, unknown>> }
}> {
  const artifactHash = input.artifactHash.replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(artifactHash)) throw new Error('artifact hash must be 32-byte hex')
  if (!input.firmwareVersion.trim()) throw new Error('firmware version is required')

  const positive = await input.execute({ id: 'positive', kind: 'positive', ...input.plan.positiveVector })
  const entries: Array<Record<string, unknown>> = [{
    id: 'positive', vectorHash: input.plan.positiveVector.fixtureHash,
    expected: 'displayed', outcome: positive.outcome,
    ...(positive.displayHash ? { displayHash: positive.displayHash } : {}),
    ...(positive.errorClass ? { errorClass: positive.errorClass } : {}),
  }]
  const positiveDisplay = positive.outcome === 'displayed' && /^[0-9a-f]{64}$/i.test(positive.displayHash || '')
    ? positive.displayHash!.toLowerCase() : undefined

  const mutations: ClearSignPromotionBundle['mutations'] = []
  for (const vector of input.plan.mutations) {
    const result = await input.execute({ id: vector.id, kind: vector.kind, payloadHex: vector.payloadHex, context: vector.context })
    let observed: ClearSignPromotionBundle['mutations'][number]['observed'] = 'unexpected-pass'
    if (vector.expected === 'reject' && result.outcome === 'rejected') observed = 'reject'
    if (vector.expected === 'different-display' && result.outcome === 'displayed'
      && positiveDisplay && /^[0-9a-f]{64}$/i.test(result.displayHash || '')
      && result.displayHash!.toLowerCase() !== positiveDisplay) observed = 'different-display'
    mutations.push({ id: vector.id, kind: vector.kind, fixtureHash: vector.fixtureHash, expected: vector.expected, observed })
    entries.push({
      id: vector.id, kind: vector.kind, vectorHash: vector.fixtureHash,
      expected: vector.expected, outcome: result.outcome,
      ...(result.displayHash ? { displayHash: result.displayHash.toLowerCase() } : {}),
      ...(result.errorClass ? { errorClass: result.errorClass } : {}),
    })
  }
  const transcript = { version: 1 as const, firmwareVersion: input.firmwareVersion, artifactHash, entries }
  const passed = Boolean(positiveDisplay) && mutations.every(value => value.observed === value.expected)
  return {
    deviceOracle: { firmwareVersion: input.firmwareVersion, artifactHash, transcriptHash: digest(transcript), passed },
    mutations, transcript,
  }
}
