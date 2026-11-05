import { validNumberLocale } from '../../shared/locale'
import { useSyncExternalStore } from 'react'

// Also usable by formatting helpers outside React. FiatProvider updates this
// synchronously when preferences load/change; its context rerenders consumers.
let numberLocale = (() => {
  try { return validNumberLocale(localStorage.getItem('keepkey-vault-locale')) }
  catch { return 'en-US' }
})()

export const getNumberLocale = () => numberLocale
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useNumberLocale = () => useSyncExternalStore(subscribe, getNumberLocale, () => 'en-US')
export function setNumberLocale(value: string) {
  const locale = validNumberLocale(value)
  if (locale !== numberLocale) {
    numberLocale = locale
    listeners.forEach(listener => listener())
  }
}
