import { describe, expect, test } from "bun:test";
import {
  assertVaultAssetResponse,
  requireVaultAsset,
  vaultAssetReceiveUri,
  evmAssetReceiveUri,
} from "../shared/vault-asset-account";
import {
  BASE_NETWORK,
  BASE_ETH_CAIP,
  BASE_USDC_CAIP,
  BITCOIN_NETWORK,
  BITCOIN_CAIP,
  safeVaultIdentity,
  bitcoinVaultIdentity,
} from "../shared/vault-identity";
import type { SafeAccount } from "../shared/safe-multisig";
const account: SafeAccount = {
  address: "0x6717d97655d8fC9d05C2DD3F28b54f574309B473",
  name: "Shared treasury",
  safeVersion: "1.5.0",
  owners: [
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ],
  threshold: 2,
  nonce: "0",
  deployed: true,
  balanceEth: "0.125",
  balanceUsdc: "42.5",
};
const vault = safeVaultIdentity(account, false);
const request = {
  vaultId: vault.id,
  networkId: BASE_NETWORK,
  assetCaip: BASE_ETH_CAIP,
};
describe("Vault asset source identity", () => {
  test("personal-wallet token receive keeps the selected asset when switching back from a vault", () => {
    const owner = account.owners[0];
    expect(evmAssetReceiveUri(BASE_NETWORK, BASE_USDC_CAIP, owner)).toBe(
      `ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453/transfer?address=${owner}`
    );
    expect(() => evmAssetReceiveUri("eip155:1", BASE_USDC_CAIP, owner)).toThrow(
      "same EVM network"
    );
  });
  test("only exact network and asset identities can select a vault account", () => {
    expect(requireVaultAsset([vault], request).address).toBe(account.address);
    expect(() =>
      requireVaultAsset([vault], {
        ...request,
        networkId: "eip155:1",
        assetCaip: "eip155:1/slip44:60",
      })
    ).toThrow("different network");
    expect(() =>
      requireVaultAsset([vault], {
        ...request,
        assetCaip:
          "eip155:8453/erc20:0x1111111111111111111111111111111111111111",
      })
    ).toThrow("not managed");
  });
  test("removed or unverified vaults cannot silently become personal-wallet accounts", () => {
    expect(() => requireVaultAsset([], request)).toThrow(
      "no longer registered"
    );
    expect(() =>
      requireVaultAsset(
        [
          {
            ...vault,
            receiveEnabled: false,
            fundingBlockedReason: "Owner review required",
          },
        ],
        request
      )
    ).toThrow("Owner review required");
  });
  test("ETH QR binds the Safe address and Base chain ID", () => {
    expect(vaultAssetReceiveUri(vault, BASE_ETH_CAIP)).toBe(
      `ethereum:${account.address}@8453`
    );
  });
  test("USDC QR targets the exact token contract with the Safe as recipient", () => {
    expect(vaultAssetReceiveUri(vault, BASE_USDC_CAIP)).toBe(
      `ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453/transfer?address=${account.address}`
    );
    expect(() => vaultAssetReceiveUri(vault, "eip155:1/slip44:60")).toThrow(
      "different network"
    );
  });
  test("a balance response for another Safe, personal wallet, asset or owner configuration is rejected", () => {
    const valid = { identity: vault, assetCaip: BASE_ETH_CAIP, safe: account };
    expect(() => assertVaultAssetResponse(request, vault, valid)).not.toThrow();
    for (const response of [
      { ...valid, assetCaip: BASE_USDC_CAIP },
      { ...valid, safe: { ...account, address: account.owners[0] } },
      { ...valid, safe: { ...account, threshold: 1 } },
      { ...valid, safe: { ...account, owners: [account.owners[0]] } },
      { ...valid, safe: undefined },
    ])
      expect(() =>
        assertVaultAssetResponse(request, vault, response)
      ).toThrow();
    expect(valid.safe.balanceEth).toBe("0.125");
  });
  test("Bitcoin receive stays on the exact registered mainnet policy", () => {
    const btc = bitcoinVaultIdentity({
      id: "policy",
      name: "BTC vault",
      descriptor: "wsh(sortedmulti(...))",
      scriptType: "p2wsh",
      threshold: 2,
      address: "bc1qexample",
      saved: true,
      sessionOnly: false,
      cosigners: [
        {
          fingerprint: "11111111",
          path: "m/48h/0h/0h/2h",
          xpub: "one",
          ours: true,
        },
        {
          fingerprint: "22222222",
          path: "m/48h/0h/0h/2h",
          xpub: "two",
          ours: false,
        },
      ],
    });
    expect(vaultAssetReceiveUri(btc, BITCOIN_CAIP)).toBe("bitcoin:bc1qexample");
    expect(() =>
      requireVaultAsset([btc], {
        vaultId: btc.id,
        networkId: BASE_NETWORK,
        assetCaip: BASE_ETH_CAIP,
      })
    ).toThrow();
    const req = {
      vaultId: btc.id,
      networkId: BITCOIN_NETWORK,
      assetCaip: BITCOIN_CAIP,
    };
    expect(() =>
      assertVaultAssetResponse(req, btc, {
        identity: { ...btc, policyId: "other-policy" },
        assetCaip: BITCOIN_CAIP,
      })
    ).toThrow("Bitcoin policy");
  });
});
