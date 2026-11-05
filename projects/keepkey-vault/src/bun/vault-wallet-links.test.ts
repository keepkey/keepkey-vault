import { expect, test } from "bun:test";
import { linkedVaultIds } from "../shared/vault-wallet-links";
import {
  safeVaultIdentity,
  BITCOIN_NETWORK,
  type VaultIdentity,
} from "../shared/vault-identity";

const owner = "0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E";
const safe = safeVaultIdentity(
  {
    name: "Treasury",
    address: "0x6717d97655d8fC9d05C2DD3F28b54f574309B473",
    owners: [owner],
    threshold: 1,
    deployed: true,
    nonce: "0",
    balanceEth: "0",
    balanceUsdc: "0",
  },
  false
);
const btc: VaultIdentity = {
  ...safe,
  id: "btc-policy",
  type: "bitcoin-multisig",
  chainId: "bitcoin",
  networkId: BITCOIN_NETWORK,
  cosigners: [{ fingerprint: "12345678", xpub: "xpubExactAccountKey" }],
};

test("Safe relationship requires an exact cached EVM owner address", () => {
  expect(
    linkedVaultIds(
      [safe],
      [{ family: "evm", address: owner.toLowerCase(), xpub: "" }]
    )
  ).toEqual([safe.id]);
  expect(
    linkedVaultIds([safe], [{ family: "evm", address: safe.address, xpub: "" }])
  ).toEqual([]);
  expect(
    linkedVaultIds([safe], [{ family: "other", address: owner, xpub: "" }])
  ).toEqual([]);
});
test("Bitcoin links require the entire account key, not a fingerprint or receiving address", () => {
  expect(
    linkedVaultIds(
      [btc],
      [{ family: "bitcoin", address: "", xpub: "xpubExactAccountKey" }]
    )
  ).toEqual([btc.id]);
  expect(
    linkedVaultIds(
      [btc],
      [{ family: "bitcoin", address: "12345678", xpub: "xpubOtherAccountKey" }]
    )
  ).toEqual([]);
  expect(
    linkedVaultIds(
      [btc],
      [{ family: "evm", address: "", xpub: "xpubExactAccountKey" }]
    )
  ).toEqual([]);
});
test("hidden session vaults never attach metadata to saved wallet tiles", () => {
  expect(
    linkedVaultIds(
      [{ ...safe, sessionOnly: true }],
      [{ family: "evm", address: owner, xpub: "" }]
    )
  ).toEqual([]);
});
