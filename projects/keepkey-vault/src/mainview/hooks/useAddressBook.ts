import { useState, useEffect, useCallback, useRef } from "react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import type { AddressBookEntry } from "../../shared/types"

/** Loads the whole address book for the active wallet and keeps it fresh via the
 *  `addressbook-changed` push. The view filters client-side (the book is small).
 *  Returns [] for passphrase wallets / no device (backend gate).
 *
 *  Own-wallet entries are seeded inside getBalances' device derivation. On launch
 *  the app serves the cached portfolio and skips getBalances when the cache is
 *  fresh, so the book can be empty even with a connected wallet. When that happens
 *  we trigger one derive to seed it; the seed fires `addressbook-changed`, which
 *  refetches. Guarded to run at most once per mount. */
export function useAddressBook() {
  const [entries, setEntries] = useState<AddressBookEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [seeding, setSeeding] = useState(false)
  const seededRef = useRef(false)

  const refetch = useCallback(() => {
    return rpcRequest<AddressBookEntry[]>("listAddressBook", {}, 10000)
      .then(rows => { setEntries(rows ?? []); return rows ?? [] })
      .catch(() => { setEntries([]); return [] as AddressBookEntry[] })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    refetch().then(rows => {
      if (rows.length === 0 && !seededRef.current) {
        seededRef.current = true
        setSeeding(true)
        // Heavy (device round-trips) — only fired when the book is genuinely empty.
        // Soft fetch: we only need the own-address seeding side effect; forced
        // Pioneer cache bypass is reserved for user-clicked refresh.
        rpcRequest("getBalances", {}, 120000)
          .catch(() => {})
          .finally(() => setSeeding(false))
      }
    })
  }, [refetch])

  useEffect(() => onRpcMessage("addressbook-changed", refetch), [refetch])

  const saveLabel = useCallback((id: string, label: string) =>
    rpcRequest("updateAddressBook", { id, label }, 5000).then(() => {}).catch(() => {}), [])
  const remove = useCallback((id: string) =>
    rpcRequest("deleteAddressBook", { id }, 5000).then(() => {}).catch(() => {}), [])

  return { entries, loading, seeding, refetch, saveLabel, remove }
}
