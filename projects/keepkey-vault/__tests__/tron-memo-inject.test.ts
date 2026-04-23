/**
 * Tests for TRON memo injection into a TronGrid `triggersmartcontract`
 * response. The injection MUST place the data field at canonical tag order
 * position (field 10, before contract/11) — appending at the end produces a
 * different sha256 than what TronGrid computes after canonicalization, so
 * the device's signature would not verify at broadcast.
 *
 * No network calls — uses a captured real TronGrid response as a fixture.
 */
import { describe, test, expect } from 'bun:test'
import { injectTronMemo } from '../src/bun/txbuilder'
import protobuf from 'protobufjs/light'

// Real TronGrid /wallet/triggersmartcontract response captured 2026-04-22 for
// USDT.transfer to a synthetic recipient (Bitcoin Genesis address as the
// 20-byte hash). Bytes were produced by TronGrid itself, so the
// canonicalization rules they apply are baked in.
const FIXTURE_TX = {
  visible: true,
  txID: '758e54c5cef88d9d98f9b31841e783559d10398d42c9a4825b33bba33bc42412',
  raw_data: {
    contract: [{
      parameter: {
        value: {
          data: 'a9059cbb000000000000000000000000a614f803b6fd780986a42c78ec9c7f77e6ded13c0000000000000000000000000000000000000000000000000000000001312d00',
          owner_address: 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax',
          contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        },
        type_url: 'type.googleapis.com/protocol.TriggerSmartContract',
      },
      type: 'TriggerSmartContract',
    }],
    ref_block_bytes: '5796',
    ref_block_hash: '9376a6a3333f4719',
    expiration: 1745353010000,
    fee_limit: 30000000,
    timestamp: 1745352952000,
  },
  raw_data_hex: '0a02579622089376a6a3333f4719408082bab6db335aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a15416e0617948fe030a7e4970f8389d4ad295f249b7e121541a614f803b6fd780986a42c78ec9c7f77e6ded13c2244a9059cbb000000000000000000000000a614f803b6fd780986a42c78ec9c7f77e6ded13c0000000000000000000000000000000000000000000000000000000001312d0070d3bcb6b6db3390018087a70e',
}

const MEMO = '=:b:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'

describe('injectTronMemo', () => {
  test('writes memo bytes into raw_data.data', async () => {
    const result = await injectTronMemo({ ...FIXTURE_TX }, MEMO)
    const decodedData = Buffer.from(result.raw_data.data, 'hex').toString('utf8')
    expect(decodedData).toBe(MEMO)
  })

  test('updates raw_data_hex with field 10 in canonical position', async () => {
    const result = await injectTronMemo({ ...FIXTURE_TX }, MEMO)
    const newBytes = Buffer.from(result.raw_data_hex, 'hex')

    // Walk the new tx and confirm we see field 10 (data) BEFORE field 11 (contract)
    const reader = new protobuf.Reader(newBytes)
    const tags: number[] = []
    while (reader.pos < reader.len) {
      const tag = reader.uint32()
      tags.push(tag >>> 3)
      reader.skipType(tag & 7)
    }
    const idx10 = tags.indexOf(10)
    const idx11 = tags.indexOf(11)
    expect(idx10).toBeGreaterThanOrEqual(0)
    expect(idx11).toBeGreaterThanOrEqual(0)
    expect(idx10).toBeLessThan(idx11)
  })

  test('preserves all original raw_data fields', async () => {
    const result = await injectTronMemo({ ...FIXTURE_TX }, MEMO)
    expect(result.raw_data.ref_block_bytes).toBe(FIXTURE_TX.raw_data.ref_block_bytes)
    expect(result.raw_data.ref_block_hash).toBe(FIXTURE_TX.raw_data.ref_block_hash)
    expect(result.raw_data.expiration).toBe(FIXTURE_TX.raw_data.expiration)
    expect(result.raw_data.fee_limit).toBe(FIXTURE_TX.raw_data.fee_limit)
    expect(result.raw_data.timestamp).toBe(FIXTURE_TX.raw_data.timestamp)
    // The contract array (smart contract calldata) must be intact byte-for-byte
    expect(result.raw_data.contract).toEqual(FIXTURE_TX.raw_data.contract as any)
  })

  test('recomputes txID as sha256(new raw_data_hex)', async () => {
    const result = await injectTronMemo({ ...FIXTURE_TX }, MEMO)
    const newBytes = Buffer.from(result.raw_data_hex, 'hex')
    const expectedTxID = Buffer.from(await crypto.subtle.digest('SHA-256', newBytes)).toString('hex')
    expect(result.txID).toBe(expectedTxID)
  })

  test('produced txID differs from original', async () => {
    const result = await injectTronMemo({ ...FIXTURE_TX }, MEMO)
    expect(result.txID).not.toBe(FIXTURE_TX.txID)
  })

  test('different memos produce different txIDs', async () => {
    const a = await injectTronMemo({ ...FIXTURE_TX }, '=:b:addr1')
    const b = await injectTronMemo({ ...FIXTURE_TX }, '=:b:addr2')
    expect(a.txID).not.toBe(b.txID)
  })

  test('handles maximum THORChain memo length (250 bytes)', async () => {
    const longMemo = '=:b:' + 'a'.repeat(246) // 250 bytes total
    const result = await injectTronMemo({ ...FIXTURE_TX }, longMemo)
    const decoded = Buffer.from(result.raw_data.data, 'hex').toString('utf8')
    expect(decoded).toBe(longMemo)
    expect(decoded.length).toBe(250)
  })

  test('does not mutate the input object', async () => {
    const input = JSON.parse(JSON.stringify(FIXTURE_TX))
    const inputSnapshot = JSON.stringify(input)
    await injectTronMemo(input, MEMO)
    expect(JSON.stringify(input)).toBe(inputSnapshot)
  })
})
