import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from './index'
import { messageKey } from '../../shared/message-key'
import { useNumberLocale } from '../lib/number-locale'
import { FIRMWARE_PROGRESS_KEYS } from '../../shared/firmware-progress'
import type { FirmwareProgress } from '../../shared/types'

export type UiValues = Record<string, string | number>
export function firmwareProgressText(progress: FirmwareProgress | null | undefined): string {
  if (!progress) return ''
  if (!progress.stage || !(progress.stage in FIRMWARE_PROGRESS_KEYS)) return translateUi(progress.message)
  const translate = i18n.t as unknown as (key: string, options: Record<string, unknown>) => string
  return translate(FIRMWARE_PROGRESS_KEYS[progress.stage], {defaultValue: progress.message})
}
export function translateUi(text: string, values?: UiValues): string {
  const translate = i18n.t as unknown as (key: string, options: Record<string, unknown>) => string
  return translate(messageKey(text), { ns: 'ui', defaultValue: text, ...values })
}

/** Subscribe each component, including memoized children, to language changes. */
export function useUiTranslation() {
  const { i18n: instance } = useTranslation('ui')
  const locale = useNumberLocale()
  return useCallback((text: string, values?: UiValues) => translateUi(text, values), [instance.resolvedLanguage, instance.language, locale])
}
