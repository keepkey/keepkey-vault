import { randomUUID } from 'node:crypto'
import type { PasswordBank } from './password-bank'
import { passwordFillOrigins, type PasswordBrowserTarget } from '../shared/password-bank'

interface Bridge {
  browsers: () => { browser: string }[]
  call: (tool: string, args: unknown, browser: string) => Promise<any>
}
type Selection = PasswordBrowserTarget & { id: string; ref: string; expiresAt: number; assertCurrent: () => void }
/** UI-only, one-use fill grants. No REST/MCP operation returns a password. */
export class PasswordBex {
  private selections = new Map<string, Selection>()
  private grants = new Map<string, Selection & { pending: boolean; slot: number }>()
  constructor(private bank: PasswordBank, private bridge: Bridge, private now = Date.now) {}
  private prune() {
    for (const map of [this.selections, this.grants]) for (const [id, value] of map) if (value.expiresAt <= this.now()) map.delete(id)
  }
  async discover(id: string): Promise<PasswordBrowserTarget[]> {
    const assertCurrent = this.bank.capture()
    const p = this.bank.view().profiles.find(p => p.id === id)
    if (!p) throw new Error('Password profile not found')
    this.prune()
    this.selections.clear()
    const matches: PasswordBrowserTarget[] = []
    for (const { browser } of this.bridge.browsers()) {
      const response = await this.bridge.call('bex_tabs', { action: 'list' }, browser)
      assertCurrent()
      if (!Array.isArray(response?.tabs)) continue
      for (const tab of response.tabs.slice(0, 100)) {
        if (!Number.isSafeInteger(tab.tabId) || typeof tab.url !== 'string') continue
        let origin: string
        try { origin = new URL(tab.url).origin } catch { continue }
        if (!passwordFillOrigins(p.origin).includes(origin)) continue
        const target = await this.bridge.call('__vault_password_targets_v1', { tabId: tab.tabId, origin }, browser)
        assertCurrent()
        if (target?.origin !== origin || typeof target.documentToken !== 'string' || !Array.isArray(target.targets)) continue
        const fields = target.targets.slice(0, 20).filter((f: any) => typeof f.ref === 'string' && f.ref.length <= 100 && typeof f.label === 'string')
        const entry: PasswordBrowserTarget = { browser, tabId: tab.tabId, title: typeof tab.title === 'string' ? tab.title.slice(0, 200) : origin, origin, documentToken: target.documentToken, targets: fields.map((f: any) => ({ ref: f.ref, label: f.label.slice(0, 100) })) }
        for (const f of entry.targets) this.selections.set(`${browser}:${tab.tabId}:${f.ref}`, { ...entry, ref: f.ref, id, expiresAt: this.now() + 30000, assertCurrent })
        if (entry.targets.length) matches.push(entry)
      }
    }
    return matches
  }
  grant(input: { id: string; pending?: boolean; browser: string; tabId: number; documentToken: string; ref: string }) {
    this.prune()
    const selection = this.selections.get(`${input.browser}:${input.tabId}:${input.ref}`)
    if (!selection || selection.id !== input.id || selection.documentToken !== input.documentToken) throw new Error('Review the matching browser fields again')
    selection.assertCurrent()
    const p = this.bank.view().profiles.find(p => p.id === input.id)
    if (input.pending && p?.rotationState !== 'submitted') throw new Error('Save the pending recovery backup and begin the website change before filling the staged password')
    // Ensure a non-expired selected cache entry exists before granting anything.
    this.bank.reveal(input.id, input.pending === true)
    const slot = input.pending ? p?.pendingSlot : p?.slot
    if (slot === undefined) throw new Error('Password profile changed. Review the fill again.')
    const grant = randomUUID()
    this.grants.set(grant, { ...selection, pending: input.pending === true, slot })
    this.selections.delete(`${input.browser}:${input.tabId}:${input.ref}`)
    return { grant }
  }
  async fill(grant: string) {
    this.prune()
    const selected = this.grants.get(grant)
    this.grants.delete(grant)
    if (!selected) throw new Error('Password fill grant expired or was already used')
    selected.assertCurrent()
    const p = this.bank.view().profiles.find(p => p.id === selected.id)
    if (!p || !passwordFillOrigins(p.origin).includes(selected.origin) || (selected.pending && p.rotationState !== 'submitted') || (selected.pending ? p.pendingSlot : p.slot) !== selected.slot) throw new Error('Password profile changed. Review the fill again.')
    const { password, expiresAt } = this.bank.reveal(selected.id, selected.pending)
    const result = await this.bridge.call('__vault_password_fill_v1', {
      tabId: selected.tabId, origin: selected.origin, documentToken: selected.documentToken,
      ref: selected.ref, password, expiresAt: Math.min(expiresAt, selected.expiresAt),
    }, selected.browser)
    if (result?.filled !== true || result?.submitted !== false) throw new Error('The extension did not confirm a safe fill')
    return { filled: true as const, submitted: false as const }
  }
}
