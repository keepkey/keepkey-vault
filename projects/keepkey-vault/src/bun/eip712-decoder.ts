/**
 * EIP-712 typed data decoder — extracts human-readable fields for signing approval UI.
 *
 * Two tiers:
 * 1. Known descriptors (Permit2, ERC-2612 Permit, DAI Permit) matched by contract + primaryType
 * 2. Generic fallback — reads types[primaryType] and auto-detects format from Solidity type names
 */
import type { EIP712DecodedField, EIP712DecodedInfo } from '../shared/types'

// ── Helpers ──────────────────────────────────────────────────────────────

function getNestedValue(obj: any, dotPath: string): any {
  return dotPath.split('.').reduce((o, key) => o?.[key], obj)
}

function humanizeFieldName(name: string): string {
  // camelCase → Title Case: "maxFeePerGas" → "Max Fee Per Gas"
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim()
}

function autoDetectFormat(solidityType: string, fieldName: string): EIP712DecodedField['format'] {
  const lowerName = fieldName.toLowerCase()
  if (solidityType === 'address') return 'address'
  if (solidityType.startsWith('bytes')) return 'hex'
  if (solidityType.startsWith('uint') || solidityType.startsWith('int')) {
    if (lowerName.includes('expir') || lowerName.includes('deadline') || lowerName.includes('validto') || lowerName.includes('validuntil')) {
      return 'datetime'
    }
    if (lowerName.includes('amount') || lowerName.includes('value') || lowerName.includes('nonce')) {
      return 'amount'
    }
    return 'raw'
  }
  return 'raw'
}

function formatValue(val: any, format: EIP712DecodedField['format']): string {
  if (val === undefined || val === null) return ''
  const str = String(val)

  switch (format) {
    case 'address':
      return str.length === 42 ? str : str
    case 'datetime': {
      const n = Number(str)
      if (!n || n > 1e15) return str // already ms or invalid
      try {
        return new Date(n * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
      } catch {
        return str
      }
    }
    case 'amount':
      return str
    case 'hex':
      return str.length > 66 ? str.slice(0, 66) + '...' : str
    default:
      return str.length > 200 ? str.slice(0, 200) + '...' : str
  }
}

// ── Known type descriptors ───────────────────────────────────────────────

const PERMIT2_ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3'

interface KnownDescriptor {
  match: (typedData: any) => boolean
  operationName: string
  extract: (message: any) => EIP712DecodedField[]
}

const KNOWN_DESCRIPTORS: KnownDescriptor[] = [
  // Uniswap Permit2 — PermitSingle
  {
    match: (td) =>
      td.domain?.verifyingContract?.toLowerCase() === PERMIT2_ADDRESS &&
      td.primaryType === 'PermitSingle',
    operationName: 'Permit2 (Single)',
    extract: (msg) => {
      const details = msg.details || {}
      return [
        { label: 'Token', value: formatValue(details.token, 'address'), format: 'address', raw: details.token },
        { label: 'Amount', value: formatValue(details.amount, 'amount'), format: 'amount', raw: details.amount },
        { label: 'Expiration', value: formatValue(details.expiration, 'datetime'), format: 'datetime', raw: details.expiration },
        { label: 'Nonce', value: formatValue(details.nonce, 'raw'), format: 'raw' },
        { label: 'Spender', value: formatValue(msg.spender, 'address'), format: 'address', raw: msg.spender },
        { label: 'Sig Deadline', value: formatValue(msg.sigDeadline, 'datetime'), format: 'datetime', raw: msg.sigDeadline },
      ]
    },
  },
  // Uniswap Permit2 — PermitBatch
  {
    match: (td) =>
      td.domain?.verifyingContract?.toLowerCase() === PERMIT2_ADDRESS &&
      td.primaryType === 'PermitBatch',
    operationName: 'Permit2 (Batch)',
    extract: (msg) => {
      const details = Array.isArray(msg.details) ? msg.details : []
      const fields: EIP712DecodedField[] = []
      details.forEach((d: any, i: number) => {
        const prefix = details.length > 1 ? `[${i + 1}] ` : ''
        fields.push(
          { label: `${prefix}Token`, value: formatValue(d.token, 'address'), format: 'address', raw: d.token },
          { label: `${prefix}Amount`, value: formatValue(d.amount, 'amount'), format: 'amount', raw: d.amount },
          { label: `${prefix}Expiration`, value: formatValue(d.expiration, 'datetime'), format: 'datetime', raw: d.expiration },
        )
      })
      fields.push(
        { label: 'Spender', value: formatValue(msg.spender, 'address'), format: 'address', raw: msg.spender },
        { label: 'Sig Deadline', value: formatValue(msg.sigDeadline, 'datetime'), format: 'datetime', raw: msg.sigDeadline },
      )
      return fields
    },
  },
  // ERC-2612 Permit (owner/spender/value/deadline)
  {
    match: (td) =>
      td.primaryType === 'Permit' &&
      td.types?.Permit?.some((f: any) => f.name === 'owner') &&
      td.types?.Permit?.some((f: any) => f.name === 'spender') &&
      td.types?.Permit?.some((f: any) => f.name === 'value') &&
      td.types?.Permit?.some((f: any) => f.name === 'deadline'),
    operationName: 'ERC-2612 Permit',
    extract: (msg) => [
      { label: 'Owner', value: formatValue(msg.owner, 'address'), format: 'address', raw: msg.owner },
      { label: 'Spender', value: formatValue(msg.spender, 'address'), format: 'address', raw: msg.spender },
      { label: 'Value', value: formatValue(msg.value, 'amount'), format: 'amount', raw: msg.value },
      { label: 'Nonce', value: formatValue(msg.nonce, 'raw'), format: 'raw' },
      { label: 'Deadline', value: formatValue(msg.deadline, 'datetime'), format: 'datetime', raw: msg.deadline },
    ],
  },
  // DAI-style Permit (holder/spender/nonce/expiry/allowed)
  {
    match: (td) =>
      td.primaryType === 'Permit' &&
      td.types?.Permit?.some((f: any) => f.name === 'holder') &&
      td.types?.Permit?.some((f: any) => f.name === 'allowed'),
    operationName: 'DAI Permit',
    extract: (msg) => [
      { label: 'Holder', value: formatValue(msg.holder, 'address'), format: 'address', raw: msg.holder },
      { label: 'Spender', value: formatValue(msg.spender, 'address'), format: 'address', raw: msg.spender },
      { label: 'Nonce', value: formatValue(msg.nonce, 'raw'), format: 'raw' },
      { label: 'Expiry', value: formatValue(msg.expiry, 'datetime'), format: 'datetime', raw: msg.expiry },
      { label: 'Allowed', value: formatValue(msg.allowed, 'raw'), format: 'raw' },
    ],
  },
]

// ── Generic fallback ─────────────────────────────────────────────────────

function genericExtract(typedData: any): EIP712DecodedField[] {
  const primaryType = typedData.primaryType
  const typeDefs = typedData.types?.[primaryType]
  const message = typedData.message || {}

  if (!Array.isArray(typeDefs)) {
    // No type definition — dump top-level message keys
    return Object.entries(message).map(([key, val]) => ({
      label: humanizeFieldName(key),
      value: formatValue(val, typeof val === 'object' ? 'raw' : 'raw'),
      format: 'raw' as const,
    }))
  }

  return typeDefs.map((field: { name: string; type: string }) => {
    const format = autoDetectFormat(field.type, field.name)
    const rawVal = message[field.name]
    // For nested struct types, stringify the object
    const displayVal = typeof rawVal === 'object' && rawVal !== null
      ? JSON.stringify(rawVal)
      : rawVal
    return {
      label: humanizeFieldName(field.name),
      value: formatValue(displayVal, format),
      format,
      raw: String(rawVal ?? ''),
    }
  })
}

// ── Public API ───────────────────────────────────────────────────────────

export function decodeEIP712(typedData: any): EIP712DecodedInfo {
  const domain = typedData.domain || {}
  const primaryType = typedData.primaryType || 'Unknown'
  const message = typedData.message || {}

  // Try known descriptors first
  for (const desc of KNOWN_DESCRIPTORS) {
    if (desc.match(typedData)) {
      return {
        operationName: desc.operationName,
        domain: {
          name: domain.name,
          version: domain.version,
          chainId: domain.chainId ? Number(domain.chainId) : undefined,
          verifyingContract: domain.verifyingContract,
        },
        primaryType,
        fields: desc.extract(message),
        isKnownType: true,
      }
    }
  }

  // Generic fallback
  return {
    operationName: humanizeFieldName(primaryType),
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId ? Number(domain.chainId) : undefined,
      verifyingContract: domain.verifyingContract,
    },
    primaryType,
    fields: genericExtract(typedData),
    isKnownType: false,
  }
}
