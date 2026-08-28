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
		expect(keepkeySolana).toContain('encodeLengthDelimited(5, accountBytes)')
		expect(keepkeySolana).toContain('encodeLengthDelimited(6, lutSignature)')
		expect(keepkeySolana).toContain('encodeVarintField(7, msg.lutProof.signerKeyId)')
		expect(keepkeySolana).toContain('encodeLengthDelimited(13, certificate)')
		expect(keepkeySolana).not.toContain('msg.swapMetadata')
	})
})
