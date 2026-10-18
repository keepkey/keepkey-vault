/** First bytes worth reading from a dropped file to recognise a PSBT. */
export const PSBT_SNIFF_BYTES = 64

/** PSBT by content, not extension (wallets save .psbt, .txn, .txt or nothing):
 *  binary "psbt\xff", base64 "cHNidP8" or hex "70736274ff", after leading whitespace/BOM. */
export function looksLikePsbt(head: Uint8Array): boolean {
	if (head.length >= 5 && head[0] === 0x70 && head[1] === 0x73 && head[2] === 0x62 && head[3] === 0x74 && head[4] === 0xff) return true
	const text = new TextDecoder().decode(head).trimStart()
	return text.startsWith('cHNidP8') || text.slice(0, 10).toLowerCase() === '70736274ff'
}
