import { useEffect, useState } from "react";
import type { AppSettings } from "../../shared/types";
import { rpcRequest } from "../lib/rpc";

/** Fail closed while Settings loads; changes take effect without restarting. */
export function useBtcMultisigEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true,
      revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try {
        const settings = await rpcRequest<AppSettings>("getAppSettings");
        if (active && revision === current)
          setEnabled(settings.btcMultisigEnabled === true);
      } catch { /* Keep the last confirmed preference; the backend gates every operation. */ }
    };
    const settingsChanged = (event: Event) => {
      const settings = (event as CustomEvent<Partial<AppSettings>>).detail;
      if (typeof settings?.btcMultisigEnabled === 'boolean') {
        revision++;
        setEnabled(settings.btcMultisigEnabled);
      } else void refresh();
    };
    void refresh();
    window.addEventListener("keepkey-settings-changed", settingsChanged);
    return () => {
      active = false;
      window.removeEventListener("keepkey-settings-changed", settingsChanged);
    };
  }, []);
  return enabled;
}
