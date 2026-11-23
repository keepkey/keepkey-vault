// Confirmations before a tx counts as final, by chain symbol. Shared by the
// activity badge (UI) and the pending-tx watcher (how long to keep rescanning).
const CONF_REQUIRED: Record<string, number> = {
  BTC: 6, LTC: 6, DOGE: 6, DASH: 6, BCH: 6, DGB: 6, ZEC: 24,
  // Polygon's symbol is POL; MATIC stays for activity rows saved before the rename (audit v6 U8).
  ETH: 12, POL: 128, MATIC: 128, AVAX: 12, BNB: 15, ARB: 12, OP: 12, BASE: 12,
  ATOM: 1, RUNE: 1, CACAO: 1, OSMO: 1,
  XRP: 1, SOL: 32, TRX: 19, TON: 1, MON: 12, HYPE: 12,
}

export function getRequiredConfs(symbol: string): number { return CONF_REQUIRED[symbol] || 6 }
