import { createContext, useContext, useState, useCallback, useEffect } from "react"
import type { FiatCurrency, AppSettings } from "../../shared/types"
import { formatFiat, formatFiatCompact, getFiatConfig } from "../../shared/fiat"
import { rpcRequest } from "./rpc"

interface FiatContextValue {
  currency: FiatCurrency
  locale: string
  /** Format USD value into the user's chosen fiat currency */
  fmt: (usdValue: number | string | null | undefined) => string
  /** Compact format (narrowSymbol) for inline display */
  fmtCompact: (usdValue: number | string | null | undefined) => string
  /** Currency symbol (e.g. "$", "\u20AC") */
  symbol: string
  /** Update fiat currency preference */
  setCurrency: (currency: FiatCurrency) => void
  /** Update number locale preference */
  setLocale: (locale: string) => void
}

const FiatContext = createContext<FiatContextValue>({
  currency: 'USD',
  locale: 'en-US',
  fmt: () => '',
  fmtCompact: () => '',
  symbol: '$',
  setCurrency: () => {},
  setLocale: () => {},
})

export function useFiat() {
  return useContext(FiatContext)
}

export function FiatProvider({ children }: { children: React.ReactNode }) {
  const [currency, setCurrencyState] = useState<FiatCurrency>(() => {
    try {
      return (localStorage.getItem('keepkey-vault-fiat') as FiatCurrency) || 'USD'
    } catch { return 'USD' }
  })
  const [locale, setLocaleState] = useState(() => {
    try {
      return localStorage.getItem('keepkey-vault-locale') || 'en-US'
    } catch { return 'en-US' }
  })

  // Load from backend settings on mount
  useEffect(() => {
    rpcRequest<AppSettings>('getAppSettings')
      .then(s => {
        if (s.fiatCurrency) setCurrencyState(s.fiatCurrency)
        if (s.numberLocale) setLocaleState(s.numberLocale)
      })
      .catch(() => {})
  }, [])

  const setCurrency = useCallback((c: FiatCurrency) => {
    setCurrencyState(c)
    try { localStorage.setItem('keepkey-vault-fiat', c) } catch {}
    // Persist to backend
    rpcRequest('setFiatCurrency', { currency: c }).catch(() => {})
  }, [])

  const setLocale = useCallback((l: string) => {
    setLocaleState(l)
    try { localStorage.setItem('keepkey-vault-locale', l) } catch {}
    rpcRequest('setNumberLocale', { locale: l }).catch(() => {})
  }, [])

  const cfg = getFiatConfig(currency)

  const fmt = useCallback((usdValue: number | string | null | undefined) => {
    return formatFiat(usdValue, currency, locale)
  }, [currency, locale])

  const fmtCompact = useCallback((usdValue: number | string | null | undefined) => {
    return formatFiatCompact(usdValue, currency, locale)
  }, [currency, locale])

  return (
    <FiatContext.Provider value={{ currency, locale, fmt, fmtCompact, symbol: cfg.symbol, setCurrency, setLocale }}>
      {children}
    </FiatContext.Provider>
  )
}
