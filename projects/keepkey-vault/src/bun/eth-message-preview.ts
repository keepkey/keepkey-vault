import type { EthMessageDecodedInfo } from '../shared/types'

/**
 * EIP-191 personal_sign / eth_sign preview, shared by REST and WalletConnect
 * so the two paths cannot drift apart. The message arrives as a hex string per
 * JSON-RPC spec; in practice it nearly always encodes UTF-8 text (SIWE, dApp
 * login challenges). Decode to plaintext so the user sees what they're
 * actually signing — raw hex alone is useless for consent.
 */
export function ethMessagePreview(address: string, message: unknown): EthMessageDecodedInfo {
  const raw = typeof message === 'string' ? message : ''
  let text: string | undefined
  let isUtf8Text = false
  if (raw) {
    const hexMatch = /^0x([0-9a-fA-F]*)$/.exec(raw)
    if (hexMatch) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hexMatch[1], 'hex'))
        isUtf8Text = true
      } catch {
        // Not valid UTF-8 — leave `text` undefined; UI will show hex.
      }
    } else {
      // Already a plaintext string (non-spec clients).
      text = raw
      isUtf8Text = true
    }
  }
  return { address, messageRaw: raw, messageText: text, isUtf8Text }
}
