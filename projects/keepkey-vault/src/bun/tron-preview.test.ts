import { test, expect } from 'bun:test'
import protobuf from 'protobufjs/light'
import { tronPreview } from './tron-preview'

const owner = Buffer.from('41' + '11'.repeat(20), 'hex')
const vault = Buffer.from('41' + '22'.repeat(20), 'hex')
const memo = '=:ETH.ETH:0x' + '33'.repeat(20) + ':1935036:keep:30'
const w = () => new protobuf.Writer()
const raw = (payload: Uint8Array, type: number, url: string) => {
  const any = w().uint32(10).string(url).uint32(18).bytes(payload).finish()
  const contract = w().uint32(8).uint32(type).uint32(18).bytes(any).finish()
  return Buffer.from(w().uint32(82).bytes(Buffer.from(memo)).uint32(90).bytes(contract).finish()).toString('hex')
}

test('TRX approval comes from signed protobuf, including memo terms', () => {
  const transfer = w().uint32(10).bytes(owner).uint32(18).bytes(vault)
    .uint32(24).uint64(257033375).finish()
  const tx = raw(transfer, 1, 'type.googleapis.com/protocol.TransferContract')
  const preview = tronPreview(tx)
  expect(preview?.amount).toBe('257.033375 TRX')
  expect(preview?.minimumOutput).toBe('0.01935036 ETH')
  expect(preview?.affiliateFee).toBe('0.30%')
  expect(preview?.memo).toBe(memo)
  // A second contract changes the signed effect; no reassuring summary.
  expect(tronPreview(tx + '5a00')).toBeNull()
})

test('only the pinned USDT contract receives six-decimal token labeling', () => {
  const usdt = Buffer.from('41a614f803b6fd780986a42c78ec9c7f77e6ded13c', 'hex')
  const other = Buffer.from('41' + '44'.repeat(20), 'hex')
  const call = Buffer.concat([Buffer.from('a9059cbb', 'hex'), Buffer.alloc(12), vault.subarray(1),
    Buffer.from((34421641n).toString(16).padStart(64, '0'), 'hex')])
  const trigger = (contract: Buffer) => w().uint32(10).bytes(owner).uint32(18).bytes(contract)
    .uint32(34).bytes(call).finish()
  expect(tronPreview(raw(trigger(usdt), 31, 'type.googleapis.com/protocol.TriggerSmartContract'))?.amount)
    .toBe('34.421641 USDT')
  expect(tronPreview(raw(trigger(other), 31, 'type.googleapis.com/protocol.TriggerSmartContract'))?.amount)
    .toBe('34421641 base units (unverified token)')
})

// 7.17 shows an approve of a table token, staking and votes itself (firmware
// tron.c tron_parseContract). The vectors are the firmware's own real mainnet
// transactions (keepkey-firmware 296aa1e2c unittests/firmware/tron_vectors.json).
import { createHash } from 'node:crypto'
import { tronShownNatively } from './tron-preview'
import firmwareVectors from '../../__tests__/fixtures/clearsign-chains/tron-717-firmware-vectors.json'

const vector = (name: string) => firmwareVectors.vectors.find((v) => v.name === name)!.raw_data_hex
// What 7.17.0 does with each vector (fsm_msgTronSignTx): shown, or "Enable
// AdvancedMode to blind-sign" (a token outside the table, a multisig
// Permission_id).
const SHOWN_ON_717 = [
  'usdt_approve_unlimited', 'usdt_approve_unlimited_41_word', 'usdt_approve_100', 'usdt_approve_100_41_word',
  'usdt_approve_revoke', 'usdd_approve', 'usdd_approve_unlimited', 'freeze_energy', 'freeze_bandwidth',
  'freeze_with_fee_limit', 'unfreeze_energy', 'unfreeze_bandwidth', 'vote_1', 'vote_3', 'vote_7',
]
const BLIND_ON_717 = ['unlisted_contract_approve', 'unlisted_contract_approve_unlimited', 'freeze_multisig_permission', 'vote_multisig_permission']

test('firmware vectors are the bytes the chain accepted', () => {
  expect(firmwareVectors.vectors).toHaveLength(SHOWN_ON_717.length + BLIND_ON_717.length)
  for (const v of firmwareVectors.vectors) {
    expect(createHash('sha256').update(Uint8Array.from(Buffer.from(v.raw_data_hex, 'hex'))).digest('hex')).toBe(v.txID)
    expect(v.source).toContain(v.txID)
  }
})

test('7.17.0 shows a table-token approve, staking and votes; 7.16.0 and unknown firmware do not', () => {
  for (const name of SHOWN_ON_717) {
    expect([name, tronShownNatively(vector(name), '7.17.0')]).toEqual([name, true])
    expect([name, tronShownNatively(vector(name), 'v7.17.1')]).toEqual([name, true])
    expect([name, tronShownNatively(vector(name), '7.16.0')]).toEqual([name, false])
    expect([name, tronShownNatively(vector(name), undefined)]).toEqual([name, false])
  }
  for (const name of BLIND_ON_717) expect([name, tronShownNatively(vector(name), '7.17.0')]).toEqual([name, false])
  // Bytes work as well as hex.
  expect(tronShownNatively(Uint8Array.from(Buffer.from(vector('vote_3'), 'hex')), '7.17.0')).toBe(true)
})

test('7.17 boundaries fail closed the way tron.c does', () => {
  const u8 = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))
  const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex')
  const OWNER = u8('41' + '11'.repeat(20)), SR = u8('41' + '22'.repeat(20))
  const tx = (payload: Uint8Array, type: number, name: string) => {
    const any = w().uint32(10).string(`type.googleapis.com/protocol.${name}`).uint32(18).bytes(payload).finish()
    const contract = w().uint32(8).uint32(type).uint32(18).bytes(any).finish()
    return hexOf(w().uint32(90).bytes(contract).finish())
  }
  const shown = (hex: string) => tronShownNatively(hex, '7.17.0')
  const stake = (amount: number, resource?: number, extra?: (x: protobuf.Writer) => void) => {
    const x = w().uint32(10).bytes(OWNER).uint32(16).uint64(amount)
    if (resource !== undefined) x.uint32(24).uint32(resource)
    extra?.(x)
    return x.finish()
  }
  expect(shown(tx(stake(1_000_000, 1), 54, 'FreezeBalanceV2Contract'))).toBe(true)
  expect(shown(tx(stake(1_000_000), 55, 'UnfreezeBalanceV2Contract'))).toBe(true) // BANDWIDTH is omitted
  expect(shown(tx(stake(1_000_000, 2), 54, 'FreezeBalanceV2Contract'))).toBe(true) // TRON POWER
  expect(shown(tx(stake(1_000_000, 3), 54, 'FreezeBalanceV2Contract'))).toBe(false) // no such resource
  expect(shown(tx(stake(0, 1), 54, 'FreezeBalanceV2Contract'))).toBe(false)
  expect(shown(tx(stake(1_000_000, 1, (x) => x.uint32(32).uint32(1)), 54, 'FreezeBalanceV2Contract'))).toBe(false) // unknown field
  expect(shown(tx(stake(1_000_000, 1), 11, 'FreezeBalanceContract'))).toBe(false) // v1 stays blind
  expect(shown(tx(stake(1_000_000, 1), 54, 'UnfreezeBalanceV2Contract'))).toBe(false) // type and type_url disagree

  const votes = (n: number, count = 5, support = false) => {
    const x = w().uint32(10).bytes(OWNER)
    for (let i = 0; i < n; i++) x.uint32(18).bytes(w().uint32(10).bytes(SR).uint32(16).uint64(count).finish())
    if (support) x.uint32(24).bool(true)
    return x.finish()
  }
  expect(shown(tx(votes(30), 4, 'VoteWitnessContract'))).toBe(true)
  expect(shown(tx(votes(31), 4, 'VoteWitnessContract'))).toBe(false) // TRON_MAX_VOTES
  expect(shown(tx(votes(0), 4, 'VoteWitnessContract'))).toBe(false)
  expect(shown(tx(votes(2, 0), 4, 'VoteWitnessContract'))).toBe(false) // zero votes for an SR
  expect(shown(tx(votes(1, 5, true), 4, 'VoteWitnessContract'))).toBe(false) // the unused support field

  const USDT = u8('41a614f803b6fd780986a42c78ec9c7f77e6ded13c')
  const approve = (data: string, callValue = 0) => {
    const x = w().uint32(10).bytes(OWNER).uint32(18).bytes(USDT)
    if (callValue) x.uint32(24).uint64(callValue)
    return tx(x.uint32(34).bytes(u8(data)).finish(), 31, 'TriggerSmartContract')
  }
  const word = '00'.repeat(12) + '22'.repeat(20)
  const amount = '00'.repeat(31) + '64'
  expect(shown(approve(`095ea7b3${word}${amount}`))).toBe(true)
  expect(shown(approve(`095ea7b3${word}${amount}`, 1))).toBe(false) // TRX sent along
  expect(shown(approve(`095ea7b3${word}${amount}00`))).toBe(false) // trailing byte
  expect(shown(approve(`39509351${word}${amount}`))).toBe(false) // increaseAllowance
  expect(shown(approve(`095ea7b301${word.slice(2)}${amount}`))).toBe(false) // dirty address word
})
