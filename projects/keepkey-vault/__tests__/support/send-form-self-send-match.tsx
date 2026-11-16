// Jasper audit v5 V6: the self-send confirmation also catches an uppercase bech32 address
// and a Bitcoin Cash address without its bitcoincash: prefix.
import { expect } from 'bun:test'
import { chainById, mount, unmount, setRecipient, text, button } from './send-form-fixture'
const warned = async (chainId: string, own: string, typed: string) => {
  await mount({ chain: chainById(chainId), address: own,
    balance: { chainId, balance: '1', balanceUsd: 0, nativeBalanceUsd: 0, address: own, syncState: 'confirmed' } })
  await setRecipient(typed)
  const result = text().includes('selfSendTitle') && button('buildTransaction').disabled
  await unmount()
  return result
}
const btc = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
const bch = 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
const eth = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const summary = {
  btcUppercase: await warned('bitcoin', btc, btc.toUpperCase()),
  bchNoPrefix: await warned('bitcoincash', `bitcoincash:${bch}`, bch),
  bchPrefixAdded: await warned('bitcoincash', bch, `bitcoincash:${bch}`),
  evmCase: await warned('ethereum', eth, eth.toLowerCase()),
  otherAddress: await warned('bitcoin', btc, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'),
}
expect(summary).toEqual({ btcUppercase: true, bchNoPrefix: true, bchPrefixAdded: true, evmCase: true, otherAddress: false })
console.log(JSON.stringify(summary))
