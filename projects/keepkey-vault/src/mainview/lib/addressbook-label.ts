import type { AddressBookEntry } from "../../shared/types"

// Loose on purpose: react-i18next's TFunction is generic per namespace and overloaded.
type Translate = (...args: any[]) => unknown

/** The backend seeds own entries with the English default `My <SYMBOL>` and stores
 *  it (bun/index.ts, syncOwnAddressBook). Translate that untouched default when it is
 *  shown; any label the user typed is returned as is. */
const DEFAULT_OWN_LABEL = /^My ([A-Z0-9]+)$/

const DEFAULT_TRANSPARENT_LABEL = /^My ([A-Z0-9]+) transparent address$/

const DEFAULT_UNIFIED_LABEL = /^My ([A-Z0-9]+) unified address$/

export function addressBookLabel(entry: Pick<AddressBookEntry, "kind" | "label">, t: Translate): string | undefined {
	const label = entry.label || undefined
	const transparent = entry.kind === "own" && label ? DEFAULT_TRANSPARENT_LABEL.exec(label) : null
	if (transparent) return String(t("ownTransparent", { ns: "addressbook", symbol: transparent[1] }))
	const unified = entry.kind === "own" && label ? DEFAULT_UNIFIED_LABEL.exec(label) : null
	if (unified) return String(t("ownUnified", { ns: "addressbook", symbol: unified[1] }))
	const match = entry.kind === "own" && label ? DEFAULT_OWN_LABEL.exec(label) : null
	return match ? String(t("ownSymbol", { ns: "addressbook", symbol: match[1] })) : label
}
