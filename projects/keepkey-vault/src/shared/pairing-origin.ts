/** What the request says it is. The name, address and icon are the app's own
 *  claims in POST /auth/pair: Desktop shows them, it cannot verify them. */
export function pairingOrigin(url: string): { kind: 'extension' | 'web' | 'local' | 'none'; label: string; extensionId?: string } {
	const raw = (url || '').trim()
	if (!raw) return { kind: 'none', label: '' }
	const ext = /^(chrome|moz|safari-web)-extension:\/\/([^/]+)/i.exec(raw)
	if (ext) return { kind: 'extension', label: ext[2]!, extensionId: ext[2]! }
	try {
		const u = new URL(raw)
		const host = u.hostname
		if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return { kind: 'local', label: u.host }
		return { kind: 'web', label: host }
	} catch {
		return { kind: 'none', label: raw }
	}
}
