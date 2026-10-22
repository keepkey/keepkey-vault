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
      } catch {
        if (active && revision === current) setEnabled(false);
      }
    };
    void refresh();
    window.addEventListener("keepkey-settings-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("keepkey-settings-changed", refresh);
    };
  }, []);
  return enabled;
}
