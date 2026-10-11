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

test('THORChain amounts use 1e8, Maya cacao 1e10, and the memo is kept', () => {
  const thor = cosmosTxPreview('/thorchain/sign-amino-transfer', doc({ type: 'thorchain/MsgSend', value: { to_address: 'thor1b', amount: [{ denom: 'tcy', amount: '1000000' }] } }, { memo: 'hi' }))!
  expect(thor.messages[0].rows).toContainEqual({ label: 'Amount', value: '0.01 TCY (1000000 tcy)' })
  expect(thor.memo).toBe('hi')
  const maya = cosmosTxPreview('/mayachain/sign-amino-transfer', doc({ type: 'mayachain/MsgSend', value: { amount: [{ denom: 'cacao', amount: '10000000000' }] } }))!
  expect(maya.messages[0].rows).toContainEqual({ label: 'Amount', value: '1 CACAO (10000000000 cacao)' })
})

test('an unknown denom stays raw, and an unknown message type still lists its fields', () => {
  const p = cosmosTxPreview('/cosmos/sign-amino', doc({ type: 'x/MsgNew', value: { receiver: 'cosmos1r', token: { denom: 'ibc/ABC', amount: '7' }, routes: [{ pool_id: '1' }] } }))!
  expect(p.messages[0].type).toBe('x/MsgNew')
  expect(p.messages[0].rows).toEqual([
    { label: 'Receiver', value: 'cosmos1r' },
    { label: 'Token', value: '7 ibc/ABC' },
    { label: 'Routes 1 · Pool id', value: '1' },
  ])
})

test('other routes and empty documents give nothing', () => {
  expect(cosmosTxPreview('/eth/sign-transaction', doc({}))).toBeUndefined()
  expect(cosmosTxPreview('/cosmos/sign-amino', { signDoc: { msgs: [] } })).toBeUndefined()
})
