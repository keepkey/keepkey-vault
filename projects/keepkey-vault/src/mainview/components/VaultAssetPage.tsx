import { useState } from 'react'
import type { TokenBalance } from '../../shared/types'
import type { ChainDef } from '../../shared/chains'
import type { VaultIdentity } from '../../shared/vault-identity'
import { VaultAssetAccount } from './VaultAssetAccount'

/** A vault account uses its own data path: mounting it must never derive a
 * connected owner's address or substitute their spendable token balance. */
export function VaultAssetPage({ vault, chain, initialToken, initialAction, watchOnly, onBack }: {
  vault: VaultIdentity
  chain: ChainDef
  initialToken?: TokenBalance
  initialAction?: 'send' | 'receive' | 'swap' | 'privacy'
  watchOnly?: boolean
  onBack: () => void
}) {
  const [assetCaip, setAssetCaip] = useState(initialToken?.caip || chain.caip)
  const [action, setAction] = useState<'send' | 'receive'>(initialAction === 'send' && !watchOnly ? 'send' : 'receive')
  const [, setBusy] = useState(false)
  if (vault.networkId !== chain.networkId || !assetCaip.startsWith(vault.networkId + '/') ||
      !vault.supportedAssets.some(asset => asset.caip.toLowerCase() === assetCaip.toLowerCase())) {
    return <div role="alert">This vault belongs to a different network.</div>
  }
  return <VaultAssetAccount vault={vault} assetCaip={assetCaip} networkId={vault.networkId}
    action={action} watchOnly={watchOnly} selector={null} onAction={setAction}
    onAsset={setAssetCaip} onBack={onBack} onBusy={setBusy} />
}
