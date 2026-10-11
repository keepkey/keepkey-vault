import { expect, test } from 'bun:test'
import { cosmosTxPreview } from './cosmosTxPreview'

const doc = (msg: any, extra: any = {}) => ({ signerAddress: 'x', signDoc: { msgs: [msg], fee: { amount: [{ denom: 'uosmo', amount: '800' }], gas: '290000' }, memo: '', ...extra } })

test('a send shows recipient and amount in whole units with the raw value', () => {
  const p = cosmosTxPreview('/osmosis/sign-amino', doc({ type: 'cosmos-sdk/MsgSend', value: { from_address: 'osmo1a', to_address: 'osmo1b', amount: [{ denom: 'uosmo', amount: '123456789123456' }] } }))!
  expect(p.title).toBe('Osmosis sign')
  expect(p.messages[0].rows).toContainEqual({ label: 'To address', value: 'osmo1b' })
  expect(p.messages[0].rows).toContainEqual({ label: 'Amount', value: '123456789.123456 OSMO (123456789123456 uosmo)' })
  expect(p.fee).toBe('0.0008 OSMO (800 uosmo)')
})

test('a delegate shows the validator, not just the sender', () => {
  const p = cosmosTxPreview('/osmosis/sign-amino-delegate', doc({ type: 'cosmos-sdk/MsgDelegate', value: { delegator_address: 'osmo1a', validator_address: 'osmovaloper1v', amount: { denom: 'uosmo', amount: '500' } } }))!
  expect(p.title).toBe('Osmosis Delegate')
  expect(p.messages[0].rows).toContainEqual({ label: 'Validator address', value: 'osmovaloper1v' })
  expect(p.messages[0].rows).toContainEqual({ label: 'Amount', value: '0.0005 OSMO (500 uosmo)' })
})

test('only each chain\'s own coin is converted; every other denom is shown as signed', () => {
  const amountOf = (route: string, type: string, c: any) =>
    cosmosTxPreview(route, doc({ type, value: { amount: [c] } }))!.messages[0].rows[0].value
  expect(amountOf('/thorchain/sign-amino-transfer', 'thorchain/MsgSend', { denom: 'rune', amount: '1000000' })).toBe('0.01 RUNE (1000000 rune)')
  expect(amountOf('/thorchain/sign-amino-transfer', 'thorchain/MsgSend', { denom: 'tcy', amount: '1000000' })).toBe('1000000 tcy')
  expect(amountOf('/mayachain/sign-amino-transfer', 'mayachain/MsgSend', { denom: 'cacao', amount: '10000000000' })).toBe('1 CACAO (10000000000 cacao)')
  expect(amountOf('/mayachain/sign-amino-transfer', 'mayachain/MsgSend', { denom: 'maya', amount: '10000' })).toBe('10000 maya')
  expect(amountOf('/osmosis/sign-amino', 'cosmos-sdk/MsgSend', { denom: 'uusdc', amount: '5000000' })).toBe('5000000 uusdc')
  expect(amountOf('/osmosis/sign-amino', 'cosmos-sdk/MsgSend', { denom: 'usdt', amount: '5' })).toBe('5 usdt')
})

test('a Maya deposit that falls back to this card keeps CACAO at 1e10', () => {
  const p = cosmosTxPreview('/mayachain/sign-amino-deposit', doc({ type: 'mayachain/MsgDeposit', value: { coins: [{ asset: 'MAYA.CACAO', amount: '10000000000' }] } }))!
  expect(p.messages[0].rows[0].value).toBe('1 CACAO (10000000000 MAYA.CACAO)')
})

test('the fee is stated only when it is the coin the device signs it in', () => {
  const feeOf = (fee: any) => cosmosTxPreview('/osmosis/sign-amino', doc({ type: 'x', value: {} }, { fee }))!.fee
  expect(feeOf({ amount: [{ denom: 'uosmo', amount: 5000 }] })).toBe('0.005 OSMO (5000 uosmo)')
  expect(feeOf({ amount: [{ denom: 'ibc/ABC', amount: '5000000' }] })).toBe('5000000 ibc/ABC requested; your KeepKey shows the fee it signs')
  expect(feeOf(undefined)).toBeUndefined()
})

test('a coin with extra fields keeps them, and an unknown message type still lists its fields', () => {
  const p = cosmosTxPreview('/cosmos/sign-amino', doc({ type: 'x/MsgNew', value: { receiver: 'cosmos1r', token: { denom: 'ibc/ABC', amount: '7' }, out: { denom: 'uatom', amount: '7', recipient: 'cosmos1x' }, routes: [{ pool_id: '1' }] } }))!
  expect(p.messages[0].type).toBe('x/MsgNew')
  expect(p.messages[0].rows).toEqual([
    { label: 'Receiver', value: 'cosmos1r' },
    { label: 'Token', value: '7 ibc/ABC' },
    { label: 'Out · Denom', value: 'uatom' },
    { label: 'Out · Amount', value: '7' },
    { label: 'Out · Recipient', value: 'cosmos1x' },
    { label: 'Routes 1 · Pool id', value: '1' },
  ])
})

test('other routes and empty documents give nothing', () => {
  expect(cosmosTxPreview('/eth/sign-transaction', doc({}))).toBeUndefined()
  expect(cosmosTxPreview('/cosmos/sign-amino', { signDoc: { msgs: [] } })).toBeUndefined()
})
