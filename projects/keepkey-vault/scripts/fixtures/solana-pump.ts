/** Synthetic Pump AMM buy. No captured wallet data or live blockhash. */
import bs58 from 'bs58'
import { createHash } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519'

export function syntheticAta(owner: Buffer, program: Buffer, mint: Buffer): Buffer {
  for (let bump = 255; bump >= 0; bump--) {
    const key = createHash('sha256').update(Buffer.concat([owner, program, mint, Buffer.from([bump]),
      Buffer.from(bs58.decode('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')), Buffer.from('ProgramDerivedAddress')])).digest()
    try { ed25519.ExtendedPoint.fromHex(key) } catch { return key }
  }
  throw new Error('no synthetic ATA found')
}

export function syntheticPumpBuy(signer = Buffer.alloc(32, 0x11), options: {
  invalidBoolean?: boolean; wrongFeeProgram?: boolean; extraData?: boolean; unknownCompanion?: boolean; mint?: string
} = {}) {
  const keys = Array.from({ length: 29 }, (_, i) => Buffer.alloc(32, i + 1))
  keys[0] = Buffer.from(signer)
  const programs: Record<number, string> = {
    11: 'ComputeBudget111111111111111111111111111111',
    13: '11111111111111111111111111111111',
    14: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    16: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    19: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    20: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    21: 'So11111111111111111111111111111111111111112',
    22: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  }
  for (const [i, key] of Object.entries(programs)) keys[Number(i)] = Buffer.from(bs58.decode(key))
  if (options.mint) keys[3] = Buffer.from(bs58.decode(options.mint))
  keys[4] = syntheticAta(keys[0], keys[20], keys[3])
  keys[5] = syntheticAta(keys[0], keys[16], keys[21])
  if (options.wrongFeeProgram) keys[22] = Buffer.alloc(32, 0xee)
  const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
  const ix = (program: number, accounts: number[], data: Buffer) =>
    Buffer.concat([Buffer.from([program, accounts.length, ...accounts, data.length]), data])
  const transfer = (to: number, amount: bigint) => ix(13, [0, to], Buffer.concat([Buffer.from([2,0,0,0]), u64(amount)]))
  const pumpData = Buffer.concat([
    Buffer.from('66063d1201daebea', 'hex'), u64(10000n), u64(20000n),
    Buffer.from([options.invalidBoolean ? 2 : 1]), ...(options.extraData ? [Buffer.from([0])] : []),
  ])
  const instructions = [
    ix(11, [], Buffer.from([2, 0x40, 0x0d, 3, 0])),
    ix(11, [], Buffer.concat([Buffer.from([3]), u64(100n)])),
    transfer(28, 123n),
    ix(14, [0,5,0,21,13,16], Buffer.from([1])),
    transfer(5, 20000n),
    ix(16, [5], Buffer.from([17])),
    ix(14, [0,4,0,3,13,20], Buffer.from([1])),
    ix(19, [1,0,2,3,21,4,5,6,7,8,9,20,16,13,14,10,19,12,15,17,18,23,22,24,25,26], pumpData),
    ix(options.unknownCompanion ? 27 : 16, [5,0,0], Buffer.from([9])),
  ]
  const message = Buffer.concat([
    Buffer.from([0x80,1,0,0,keys.length]), ...keys, Buffer.alloc(32, 0xbb),
    Buffer.from([instructions.length]), ...instructions, Buffer.from([0]),
  ])
  return { message, rawTx: Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64') }
}
