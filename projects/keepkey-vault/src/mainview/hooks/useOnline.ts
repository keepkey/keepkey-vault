import { useEffect, useState } from "react"

/** Tracks browser connectivity via navigator.onLine + online/offline events.
 *  Reflects the OS's view of the network — the airplane-mode *setting* is a
 *  separate, deliberate switch (AppSettings.offlineMode). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator !== "undefined" ? navigator.onLine : true))
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener("online", up)
    window.addEventListener("offline", down)
    return () => {
      window.removeEventListener("online", up)
      window.removeEventListener("offline", down)
    }
  }, [])
  return online
}
