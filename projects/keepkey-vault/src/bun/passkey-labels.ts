/**
 * The KeepKey stores only SHA-256(rpId) for each passkey, so site names are resolved here:
 * a user-set label wins, then a known domain whose hash matches, else "unknown".
 * `extraDomains` is where other sources plug in (e.g. domains the browser extension saw).
 */
import { createHash } from 'node:crypto'

/** Sites that offer passkeys and are likely on a KeepKey user's list. Matched by hash, never guessed. */
export const KNOWN_RP_IDS = [
  'google.com', 'github.com', 'microsoft.com', 'apple.com', 'amazon.com', 'facebook.com', 'x.com', 'twitter.com',
  'linkedin.com', 'dropbox.com', 'cloudflare.com', 'coinbase.com', 'binance.com', 'kraken.com', 'gemini.com',
  'bitwarden.com', '1password.com', 'proton.me', 'paypal.com', 'stripe.com', 'shopify.com', 'docker.com',
  'npmjs.com', 'gitlab.com', 'atlassian.com', 'slack.com', 'discord.com', 'reddit.com', 'ebay.com', 'adobe.com',
  'okta.com', 'bitfinex.com', 'bybit.com', 'okx.com', 'uphold.com', 'vercel.com', 'openai.com', 'anthropic.com',
  'keepkey.com', 'shapeshift.com', 'webauthn.io', 'passkeys.io',
]

export type LabelSource = 'you' | 'known' | 'unknown'
export interface ResolvedLabel { label: string; source: LabelSource }

export const rpHashHex = (rpId: string) => createHash('sha256').update(rpId.toLowerCase(), 'utf8').digest('hex')

export function resolveLabels(hashes: string[], userLabels: Record<string, string> = {}, extraDomains: string[] = []): Record<string, ResolvedLabel> {
  const known = new Map<string, string>()
  for (const d of [...KNOWN_RP_IDS, ...extraDomains]) known.set(rpHashHex(d), d.toLowerCase())
  return Object.fromEntries(hashes.map(h => {
    const mine = userLabels[h]?.trim()
    return [h, mine ? { label: mine, source: 'you' as const } : known.has(h) ? { label: known.get(h)!, source: 'known' as const } : { label: '', source: 'unknown' as const }]
  }))
}

/** A user label is short, single-line text; it is shown, never interpreted. */
export function cleanLabel(raw: unknown): string {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
}
