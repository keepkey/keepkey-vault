// Jasper audit v5 V6: the self-send confirmation also catches an uppercase bech32 address
// and a Bitcoin Cash address without its bitcoincash: prefix.
import { expect } from 'bun:test'
import { chainById, mount, unmount, setRecipient, setInput, text, button, calls } from './send-form-fixture'
const warned = async (chainId: string, own: string, typed: string) => {
  await mount({ chain: chainById(chainId), address: own,
    balance: { chainId, balance: '1', balanceUsd: 0, nativeBalanceUsd: 0, address: own, syncState: 'confirmed' } })
  await setRecipient(typed)
  await setInput('amountPlaceholder', '0.1')
  const result = text().includes('selfSendTitle') && button('buildTransaction').disabled
  expect(calls).toEqual([])
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
  bchUppercase: await warned('bitcoincash', `bitcoincash:${bch}`, bch.toUpperCase()),
  evmCase: await warned('ethereum', eth, eth.toLowerCase()),
  otherAddress: await warned('bitcoin', btc, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'),
  base58Distinct: await warned('solana', 'EESBWmGFWwLb1YSGnrg8KPzyLjLQpGnRQyCu7648VMzx', 'EESBWMGFWWLB1YSGNRG8KPZYLJLQPGNRQYCU7648VMZX'),
}
expect(summary).toEqual({ btcUppercase: true, bchNoPrefix: true, bchPrefixAdded: true, bchUppercase: true, evmCase: true, otherAddress: false, base58Distinct: false })
console.log(JSON.stringify(summary))
