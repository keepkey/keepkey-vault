/** Coverage accounting, not an approval decision. Every source row survives. */
export interface EcosystemInventoryInput {
  assets: Record<string, any>
  denied: string[]
  tokens: Record<string, { symbol: string; decimals: number }>
  rpcChains: string[]
  certificateChains: number[]
}

export const ECOSYSTEM_INVENTORY_POLICY_VERSION = 5

function evmIdentity(caip: string): string | undefined {
  const match = /^eip155:([1-9][0-9]*)\/(?:erc20|bep20):(0x[0-9a-f]{40})$/i.exec(caip)
  return match ? `${Number(match[1])}:${match[2].toLowerCase()}` : undefined
}

export function inventoryDiscovery(input: EcosystemInventoryInput) {
  const denied = new Set(input.denied.map(caip => evmIdentity(caip) || caip))
  const retiredNetworks = new Set(['binance:bnb-beacon-chain'])
  const rows = Object.entries(input.assets).sort(([a], [b]) => a.localeCompare(b)).map(([caip, asset]) => {
    const network = caip.split('/')[0]
    const namespace = network.split(':')[0]
    const standard = caip.split('/')[1]?.split(':')[0] || 'unknown'
    const identity = evmIdentity(caip)
    const blockers: string[] = []
    if (denied.has(identity || caip)) blockers.push('denylisted')
    if (retiredNetworks.has(network)) blockers.push('network-retired-no-new-blocks')
    if (namespace === 'solana' && network !== 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') {
      blockers.push('invalid-network-identity')
    }
    if (!asset || typeof asset !== 'object') blockers.push('invalid-source-record')
    else {
      if (asset.assetId && asset.assetId !== caip) blockers.push('asset-id-mismatch')
      if (asset.chainId && asset.chainId !== network) blockers.push('network-mismatch')
    }
    if (namespace === 'eip155' && (standard === 'erc20' || standard === 'bep20')) {
      if (!identity) blockers.push('invalid-contract-identity')
      const chain = Number(network.slice(7))
      if (!Number.isSafeInteger(chain) || chain < 1 || chain > 0xffffffff) blockers.push('firmware-chain-id-range')
      if (!Number.isInteger(asset?.decimals) || asset.decimals < 0 || asset.decimals > 36) blockers.push('missing-or-unsupported-decimals')
      if (typeof asset?.symbol !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,9}$/.test(asset.symbol)) blockers.push('firmware-symbol-format')
      if (!input.rpcChains.includes(String(chain))) blockers.push('verification-rpc-missing')
      if (!input.certificateChains.includes(chain)) blockers.push('chain-certificate-missing')
      if (identity && !Object.hasOwn(input.tokens, identity)) blockers.push('not-in-reviewed-token-snapshot')
      if (identity && Object.hasOwn(input.tokens, identity) &&
        (input.tokens[identity].symbol !== asset?.symbol || input.tokens[identity].decimals !== asset?.decimals)) blockers.push('snapshot-identity-mismatch')
    } else if (standard === 'slip44') {
      const slip44 = caip.slice(caip.indexOf('/slip44:') + '/slip44:'.length)
      if (!/^(0|[1-9][0-9]*)$/.test(slip44)) blockers.push('invalid-slip44-identity')
      else blockers.push('native-device-coverage-unverified')
    }
    else if (namespace === 'solana') blockers.push('mint-identity-audit-required', 'token-instruction-device-coverage-unverified')
    else blockers.push('chain-format-device-coverage-unverified')
    return { caip, network, namespace, standard, identity: identity || caip,
      symbol: typeof asset?.symbol === 'string' ? asset.symbol : null,
      decimals: Number.isInteger(asset?.decimals) ? asset.decimals : null,
      status: blockers.some(blocker => blocker === 'denylisted' || blocker === 'network-retired-no-new-blocks'
        || blocker === 'invalid-network-identity' || blocker === 'invalid-slip44-identity')
        ? 'denied' : blockers.length ? 'needs-work' : 'eligible-on-demand',
      blockers,
      requiredVerification: blockers.length ? 'audit-before-approval' : 'live-rpc-identity-and-device-review',
    }
  })
  const byStatus: Record<string, number> = {}
  const byNamespace: Record<string, number> = {}
  const byBlocker: Record<string, number> = {}
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1
    byNamespace[row.namespace] = (byNamespace[row.namespace] || 0) + 1
    for (const blocker of row.blockers) byBlocker[blocker] = (byBlocker[blocker] || 0) + 1
  }
  return { rows, summary: { totalAssets: rows.length, uniqueIdentities: new Set(rows.map(r => r.identity)).size,
    byStatus, byNamespace, byBlocker, deviceVerifiedAssets: 0 } }
}
