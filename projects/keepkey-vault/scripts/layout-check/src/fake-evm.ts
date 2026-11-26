const owner = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const evm = { evmAddresses: { addresses: [{ addressIndex: 0, address: owner, chainBalances: {} }], selectedIndex: 0, totalBalanceUsd: 0 }, initialLoaded: true, refresh: async () => {}, selectIndex() {}, addIndex() {}, removeIndex() {}, loading: false }
export function useEvmAddresses() { return evm }
