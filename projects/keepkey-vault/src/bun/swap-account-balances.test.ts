import { expect, test } from "bun:test";
import type { ChainBalance, EvmAddressSet } from "../shared/types";
import {
  scopeSwapBalances,
  swapAccountAmount,
} from "../shared/swap-account-balances";
const caip = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const asset = { caip, contractAddress: caip.split(":").at(-1)! };
const token = (balance: string) => ({
  caip,
  symbol: "USDC",
  name: "USD Coin",
  contractAddress: asset.contractAddress,
  balance,
  balanceUsd: Number(balance),
  priceUsd: 1,
  decimals: 6,
});
const aggregate: ChainBalance = {
  chainId: "base",
  symbol: "ETH",
  address: "0x1111111111111111111111111111111111111111",
  balance: "3",
  balanceUsd: 3000,
  tokens: [token("1435.923181")],
  syncState: "confirmed",
};
const accounts: EvmAddressSet = {
  selectedIndex: 1,
  totalBalanceUsd: 3000,
  addresses: [
    {
      addressIndex: 0,
      address: aggregate.address,
      balanceUsd: 2000,
      chainBalances: {
        base: {
          chainId: "base",
          symbol: "ETH",
          balance: "2",
          balanceUsd: 2000,
          nativeBalanceUsd: 564.076819,
          tokens: [token("1314.415581")],
          syncState: "confirmed",
        },
      },
    },
    {
      addressIndex: 1,
      address: "0x2222222222222222222222222222222222222222",
      balanceUsd: 1000,
      chainBalances: {
        base: {
          chainId: "base",
          symbol: "ETH",
          balance: "1",
          balanceUsd: 1000,
          nativeBalanceUsd: 878.4924,
          tokens: [token("121.5076")],
          syncState: "confirmed",
        },
      },
    },
  ],
};
test("picker, Available and MAX use selected-owner USDC rather than the chain total", () => {
  const rows = scopeSwapBalances([aggregate], undefined, accounts, 1);
  expect(rows).toHaveLength(1);
  expect(rows[0].address).toBe(accounts.addresses[1].address);
  expect(rows[0].tokens![0].balance).toBe("121.5076");
  expect(swapAccountAmount(rows[0], asset)).toBe("121.5076");
  expect(
    scopeSwapBalances([aggregate], undefined, accounts, 0)[0].tokens![0].balance
  ).toBe("1314.415581");
});
test("missing owner or chain cache never falls back to aggregate amounts", () => {
  expect(
    scopeSwapBalances([aggregate], aggregate, { ...accounts, addresses: [] }, 1)
  ).toEqual([]);
  expect(
    scopeSwapBalances(
      [aggregate],
      aggregate,
      {
        ...accounts,
        addresses: [{ ...accounts.addresses[1], chainBalances: {} }],
      },
      1
    )
  ).toEqual([]);
  expect(swapAccountAmount(undefined, asset)).toBeNull();
});
test("token absence never borrows a funded sibling address and must be confirmed to claim zero", () => {
  const empty = { ...aggregate, tokens: [], syncState: undefined };
  expect(swapAccountAmount(empty, asset)).toBeNull();
  expect(swapAccountAmount({ ...empty, syncState: "confirmed" }, asset)).toBe(
    "0"
  );
  expect(
    swapAccountAmount({ ...aggregate, syncState: "degraded" }, asset)
  ).toBeNull();
  expect(
    swapAccountAmount(
      { ...aggregate, syncState: "degraded", confirmedAssetCaips: [caip] },
      asset
    )
  ).toBe("1435.923181");
});
test("non-EVM cache/fallback behavior is preserved", () => {
  const btc = {
    ...aggregate,
    chainId: "bitcoin",
    symbol: "BTC",
    tokens: undefined,
  };
  expect(scopeSwapBalances([btc], undefined, accounts, 1)[0]).toEqual(btc);
  expect(scopeSwapBalances([], btc, accounts, 1)[0]).toEqual(btc);
});
