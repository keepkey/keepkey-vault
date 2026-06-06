import { useState, useEffect, useCallback } from "react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import type { AddressBookEntry } from "../../shared/types"

/** Loads the whole address book for the active wallet and keeps it fresh via the
 *  `addressbook-changed` push. The view filters client-side (the book is small).
 *  Returns [] for passphrase wallets / no device (backend gate). */
export function useAddressBook() {
  const [entries, setEntries] = useState<AddressBookEntry[]>([])
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(() => {
    setLoading(true)
    rpcRequest<AddressBookEntry[]>("listAddressBook", {}, 10000)
      .then(rows => setEntries(rows ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { refetch() }, [refetch])
  useEffect(() => onRpcMessage("addressbook-changed", refetch), [refetch])

  const saveLabel = useCallback((id: string, label: string) =>
    rpcRequest("updateAddressBook", { id, label }, 5000).then(() => {}).catch(() => {}), [])
  const remove = useCallback((id: string) =>
    rpcRequest("deleteAddressBook", { id }, 5000).then(() => {}).catch(() => {}), [])

  return { entries, loading, refetch, saveLabel, remove }
}
