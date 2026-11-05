import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { useUiTranslation } from "../i18n/ui"
import type { EvmAddressSet } from "../../shared/types"
import type { VaultIdentity } from "../../shared/vault-identity"
import { vaultLinkColor } from "../../shared/vault-wallet-links"
import "./VaultAccountSelector.css"

function snippet(address?: string) {
  return address ? `${address.slice(0, 8)}…${address.slice(-6)}` : ""
}

function VaultMark() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.6 8.7 8 11 4.4-2.3 8-6 8-11V5l-8-3Z" stroke="currentColor" strokeWidth="1.6"/><path d="M8 11h8m-4-4v8" stroke="currentColor" strokeWidth="1.6"/></svg>
}

/** One source picker: personal accounts and vaults remain separate identities. */
export function VaultAccountSelector({
  vaults, networkId, assetCaip, selected, onSelect, disabled = false,
  personalAccounts, selectedIndex, onSelectIndex, onAddIndex, adding = false,
  walletLabel, walletAddress, walletControls,
}: {
  vaults: VaultIdentity[]
  networkId: string
  assetCaip: string
  selected?: VaultIdentity
  onSelect: (vault?: VaultIdentity) => void
  disabled?: boolean
  personalAccounts?: EvmAddressSet["addresses"]
  selectedIndex?: number
  onSelectIndex?: (index: number) => void
  onAddIndex?: () => void
  adding?: boolean
  walletLabel?: string
  walletAddress?: string
  walletControls?: ReactNode
}) {
  const uiText = useUiTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  // A matching address or symbol on another chain is never a valid account.
  const matches = vaults.filter(v => v.networkId === networkId &&
    assetCaip.startsWith(`${networkId}/`) &&
    v.supportedAssets.some(a => a.caip.toLowerCase() === assetCaip.toLowerCase()))
  const personal = personalAccounts?.find(a => a.addressIndex === selectedIndex)
  const selectionAvailable = !selected || matches.some(v => v.id === selected.id && v.receiveEnabled)
  const currentLabel = selected?.name || (personal ? `${uiText("Account #")}${personal.addressIndex}` : walletLabel || uiText("KeepKey wallet"))
  const currentAddress = selected?.address || personal?.address || walletAddress

  useEffect(() => { setOpen(false) }, [networkId, assetCaip, disabled])
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener("mousedown", outside)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("mousedown", outside)
      document.removeEventListener("keydown", escape)
    }
  }, [open])

  const choosePersonal = (index?: number) => {
    onSelect()
    if (index !== undefined) onSelectIndex?.(index)
    setOpen(false)
  }
  const navigate = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    // Bitcoin's embedded account controls retain their own keyboard behavior.
    if (!(event.target as HTMLElement).matches('[role="menuitemradio"], [role="menuitem"]')) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)'))
    if (!buttons.length) return
    event.preventDefault()
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  return (
    <div className={`vault-account-picker${open ? " is-open" : ""}`} ref={ref}>
      <button type="button" ref={triggerRef} className="vault-account-trigger v3-glass-pill electrobun-webkit-app-region-no-drag"
        disabled={disabled} aria-label={uiText("Sending or receiving account")} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('button[role="menuitemradio"]:not(:disabled)')?.focus()) } }}>
        <span className="vault-account-avatar" style={selected ? { color: vaultLinkColor(selected.id) } : undefined}>
          {selected ? <VaultMark/> : personal ? `#${personal.addressIndex}` : "◇"}
        </span>
        <span className="vault-account-trigger-copy">
          <span className="vault-account-label">{currentLabel}</span>
          <span className={`vault-account-detail${!selectionAvailable ? " is-unavailable" : ""}`} title={currentAddress}>
            {selectionAvailable ? snippet(currentAddress) || networkId : uiText("Unavailable — choose an account")}
          </span>
        </span>
        {selected && <span className="vault-account-kind" style={{ color: vaultLinkColor(selected.id) }}>{uiText("Vault")}</span>}
        <span className="vault-account-chevron" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div id={menuId} className="vault-account-menu v3-glass-card-overlay electrobun-webkit-app-region-no-drag" role="menu" aria-label={uiText("Choose account")} onKeyDown={navigate}>
          <div className="vault-account-group">{uiText("Wallet accounts")}</div>
          {personalAccounts?.length ? personalAccounts.map(account => (
            <button type="button" key={account.addressIndex} className="vault-account-option" role="menuitemradio" aria-checked={!selected && account.addressIndex === selectedIndex} onClick={() => choosePersonal(account.addressIndex)}>
              <span className="vault-account-avatar">#{account.addressIndex}</span>
              <span className="vault-account-option-copy"><span className="vault-account-label">{uiText("Account #")}{account.addressIndex}</span><span className="vault-account-detail" title={account.address}>{snippet(account.address)}</span></span>
              {!selected && account.addressIndex === selectedIndex && <span className="vault-account-check" aria-hidden="true">✓</span>}
            </button>
          )) : (
            <button type="button" className="vault-account-option" role="menuitemradio" aria-checked={!selected} onClick={() => choosePersonal()}>
              <span className="vault-account-avatar">◇</span>
              <span className="vault-account-option-copy"><span className="vault-account-label">{walletLabel || uiText("KeepKey wallet")}</span><span className="vault-account-detail" title={walletAddress}>{snippet(walletAddress) || networkId}</span></span>
              {!selected && <span className="vault-account-check" aria-hidden="true">✓</span>}
            </button>
          )}
          {walletControls && !selected && <div className="vault-account-wallet-controls">{walletControls}</div>}
          {onAddIndex && <button type="button" className="vault-account-option vault-account-add" role="menuitem" disabled={adding} onClick={onAddIndex}>{adding ? uiText("Adding account…") : uiText("＋ Add account")}</button>}
          {matches.length > 0 && <>
            <div className="vault-account-group vault-account-divider">{uiText("Vaults")}<span>{networkId}</span></div>
            {matches.map(vault => (
              <button type="button" key={vault.id} className="vault-account-option" role="menuitemradio" aria-checked={selected?.id === vault.id} disabled={!vault.receiveEnabled} onClick={() => { onSelect(vault); setOpen(false) }}>
                <span className="vault-account-avatar" style={{ color: vaultLinkColor(vault.id) }}><VaultMark/></span>
                <span className="vault-account-option-copy"><span className="vault-account-label">{vault.name}</span><span className="vault-account-detail" title={vault.address}>{snippet(vault.address)} · {vault.threshold} {uiText("of")} {vault.cosigners.length}{!vault.receiveEnabled ? ` · ${uiText("Review required")}` : ""}</span></span>
                {selected?.id === vault.id && <span className="vault-account-check" aria-hidden="true">✓</span>}
              </button>
            ))}
          </>}
        </div>
      )}
    </div>
  )
}
