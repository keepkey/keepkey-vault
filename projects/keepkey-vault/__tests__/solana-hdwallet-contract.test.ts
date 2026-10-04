import { describe, expect, test } from 'bun:test'

describe('pinned hdwallet certified Solana contract', () => {
	test('keeps schema and certificate mandatory while LUT evidence remains optional', async () => {
		// This source-contract test guards the parent gitlink itself. A Vault-only
		// policy test cannot detect an older hdwallet pin silently dropping the
		// certified envelope before the protobuf message reaches firmware.
		const [coreSolana, keepkeySolana] = await Promise.all([
			Bun.file(new URL('../../../modules/hdwallet/packages/hdwallet-core/src/solana.ts', import.meta.url)).text(),
			Bun.file(new URL('../../../modules/hdwallet/packages/hdwallet-keepkey/src/solana.ts', import.meta.url)).text(),
		])

		expect(coreSolana).toMatch(/lutProof\?:/)
		expect(coreSolana).toMatch(/schema\?:/)
		expect(coreSolana).toMatch(/certificate\?:/)
		expect(keepkeySolana).toContain('if (msg.lutProof)')
		expect(keepkeySolana).toMatch(/encodeLengthDelimited\(5, (?:toSolanaPubkey\(account, "lut account"\)|accountBytes)\)/)
		expect(keepkeySolana).toMatch(/encodeLengthDelimited\(6, (?:toBytes\(msg\.lutProof\.signature\)|lutSignature)\)/)
		expect(keepkeySolana).toContain('encodeVarintField(7, msg.lutProof.signerKeyId)')
		expect(keepkeySolana).toContain('encodeLengthDelimited(13, certificate)')
		expect(keepkeySolana).not.toContain('msg.swapMetadata')
	})

	test('forwards certified token identities, including their delegate signature', async () => {
		// Certified TOKEN_AMOUNT display depends on SolanaSignTx.token_info (4)
		// carrying SolanaTokenInfo.signature (4) and signer_key_id (5). A pin
		// that dropped either would silently fall back to raw amounts.
		const [coreSolana, keepkeySolana] = await Promise.all([
			Bun.file(new URL('../../../modules/hdwallet/packages/hdwallet-core/src/solana.ts', import.meta.url)).text(),
			Bun.file(new URL('../../../modules/hdwallet/packages/hdwallet-keepkey/src/solana.ts', import.meta.url)).text(),
		])
		expect(coreSolana).toMatch(/tokenInfo\?: SolanaTokenInfo\[\]/)
		expect(coreSolana).toMatch(/signature\?: Uint8Array \| string/)
		expect(coreSolana).toMatch(/signerKeyId\?: number/)
		expect(keepkeySolana).toContain('extraFields.push(encodeLengthDelimited(4, encodeSolanaTokenInfo(tokenInfo)))')
		expect(keepkeySolana).toContain('fields.push(encodeLengthDelimited(4, signature))')
		expect(keepkeySolana).toContain('fields.push(encodeVarintField(5, info.signerKeyId))')
	})
})
