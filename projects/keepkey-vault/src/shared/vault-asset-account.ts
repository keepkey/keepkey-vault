import type { SafeAccount } from "./safe-multisig";
import {
  BASE_NETWORK,
  BASE_USDC_CAIP,
  BITCOIN_NETWORK,
  type VaultIdentity,
} from "./vault-identity";

export interface VaultAssetRequest {
  vaultId: string;
  networkId: string;
  assetCaip: string;
}
export interface VaultAssetAccount {
  identity: VaultIdentity;
  assetCaip: string;
  safe?: SafeAccount;
}
/** Explicit source selection must fail closed. Never substitute the personal
 * wallet when the selected vault disappears or the asset/network changes. */
export function requireVaultAsset(
  vaults: VaultIdentity[],
  request: VaultAssetRequest
): VaultIdentity {
  const vault = vaults.find((v) => v.id === request.vaultId);
  if (!vault)
    throw new Error(
      "Selected vault is no longer registered. Choose an account again."
    );
  if (
    vault.networkId !== request.networkId ||
    typeof request.assetCaip !== "string" ||
    !request.assetCaip.startsWith(request.networkId + "/")
  )
    throw new Error("Selected vault belongs to a different network");
  if (
    !vault.supportedAssets.some(
      (a) => a.caip.toLowerCase() === request.assetCaip.toLowerCase()
    )
  )
    throw new Error("This asset is not managed by the selected vault");
  if (!vault.receiveEnabled)
    throw new Error(
      vault.fundingBlockedReason ||
        "Verify the vault deployment and owner configuration first"
    );
  return vault;
}
export function assertVaultControlSnapshot(
  identity: VaultIdentity,
  account: SafeAccount
) {
  const owners = identity.cosigners
    .map((c) => c.address?.toLowerCase())
    .sort()
    .join();
  if (
    identity.type !== "safe" ||
    account.address.toLowerCase() !== identity.address.toLowerCase() ||
    !account.deployed ||
    account.configurationChanged ||
    account.threshold !== identity.threshold ||
    account.owners
      .map((a) => a.toLowerCase())
      .sort()
      .join() !== owners ||
    account.safeVersion !== (identity.safeVersion || "1.4.1")
  )
    throw new Error(
      "Vault configuration changed or the response belongs to another account. Review the vault before continuing."
    );
}
export function assertVaultAssetResponse(
  request: VaultAssetRequest,
  expected: VaultIdentity,
  response: VaultAssetAccount
) {
  requireVaultAsset([expected], request);
  requireVaultAsset([response.identity], request);
  if (
    response.assetCaip !== request.assetCaip ||
    response.identity.address.toLowerCase() !== expected.address.toLowerCase()
  )
    throw new Error(
      "Vault response differs from the selected source account or asset"
    );
  if (expected.type === "safe") {
    if (!response.safe) throw new Error("Selected Safe balance is unverified");
    assertVaultControlSnapshot(expected, response.safe);
  } else if (response.identity.policyId !== expected.policyId || response.safe)
    throw new Error("Bitcoin policy differs from the selected vault");
}
export function vaultAssetReceiveUri(
  vault: VaultIdentity,
  assetCaip: string
): string {
  requireVaultAsset([vault], {
    vaultId: vault.id,
    networkId: vault.networkId,
    assetCaip,
  });
  if (vault.type === "bitcoin-multisig" && vault.networkId === BITCOIN_NETWORK)
    return `bitcoin:${vault.address}`;
  if (vault.type !== "safe" || vault.networkId !== BASE_NETWORK)
    throw new Error("Unsupported vault receive network");
  if (assetCaip.toLowerCase() === BASE_USDC_CAIP.toLowerCase()) {
    const token = vault.supportedAssets.find(
      (a) => a.caip.toLowerCase() === assetCaip.toLowerCase()
    )!;
    return `ethereum:${token.contract}@8453/transfer?address=${vault.address}`;
  }
  return `ethereum:${vault.address}@8453`;
}
/** ERC-681 amount omission prompts the payer for an amount. Token requests
 * target the ERC-20 contract; the account is the transfer recipient. */
export function evmAssetReceiveUri(
  networkId: string,
  assetCaip: string,
  account: string
): string {
  if (
    !/^eip155:[1-9]\d*$/.test(networkId) ||
    !assetCaip.startsWith(networkId + "/") ||
    !/^0x[0-9a-f]{40}$/i.test(account)
  )
    throw new Error(
      "Receive account and asset must belong to the same EVM network"
    );
  const ref = assetCaip.slice(networkId.length + 1);
  const token = /^erc20:(0x[0-9a-f]{40})$/i.exec(ref);
  if (token)
    return `ethereum:${token[1]}@${networkId.slice(
      7
    )}/transfer?address=${account}`;
  if (!/^slip44:\d+$/.test(ref))
    throw new Error("Unsupported receive asset identifier");
  return `ethereum:${account}@${networkId.slice(7)}`;
}
