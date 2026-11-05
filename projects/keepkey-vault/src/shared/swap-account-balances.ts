import { CHAINS, isTokenCaip } from "./chains";
import type { ChainBalance, EvmAddressSet } from "./types";
import { isBalanceUnverified } from "./balance-display-state";
import { normalizeAssetCaip } from "./balance-reconciliation";

/** The picker and spendable amount must describe the same signing account.
 * Aggregate EVM rows are metadata only: never use them to fill missing owner data. */
export function scopeSwapBalances(
  cached: ChainBalance[],
  fallback: ChainBalance | undefined,
  accounts: EvmAddressSet,
  index: number,
  extraEvmChains: string[] = []
): ChainBalance[] {
  const evmIds = new Set([
    ...CHAINS.filter((c) => c.chainFamily === "evm").map((c) => c.id),
    ...extraEvmChains,
  ]);
  const all = new Map(cached.map((b) => [b.chainId, b]));
  if (fallback && !all.has(fallback.chainId))
    all.set(fallback.chainId, fallback);
  const result = [...all.values()].filter((b) => !evmIds.has(b.chainId));
  const owner = accounts.addresses.find((a) => a.addressIndex === index);
  for (const [chainId, balance] of Object.entries(owner?.chainBalances || {})) {
    if (!evmIds.has(chainId) || !owner) continue;
    result.push({
      ...balance,
      chainId,
      address: owner.address,
      symbol:
        CHAINS.find((c) => c.id === chainId)?.symbol ||
        all.get(chainId)?.symbol ||
        "",
    });
  }
  return result;
}

export function swapAccountAmount(
  balance: ChainBalance | undefined,
  asset: { caip?: string; contractAddress?: string }
): string | null {
  if (!balance || isBalanceUnverified(balance, asset.caip)) return null;
  if (!asset.contractAddress && !isTokenCaip(asset.caip))
    return balance.balance;
  if (!asset.caip) return null;
  const wanted = normalizeAssetCaip(asset.caip);
  const token = balance.tokens?.find(
    (t) => normalizeAssetCaip(t.caip) === wanted
  );
  if (token) return token.balance;
  // Only a complete response or direct token read can prove an absent token is zero.
  return balance.syncState === "confirmed" ||
    balance.confirmedAssetCaips?.some((c) => normalizeAssetCaip(c) === wanted)
    ? "0"
    : null;
}
