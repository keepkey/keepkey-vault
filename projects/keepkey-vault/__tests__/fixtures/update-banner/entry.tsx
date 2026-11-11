import React from 'react'
import { createRoot } from 'react-dom/client'
import { ChakraProvider } from '@chakra-ui/react'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { UpdateBanner } from '../../../src/mainview/components/UpdateBanner'
import { system } from '../../../src/mainview/theme'
import words from '../../../src/mainview/i18n/locales/en/update.json'
import '../../../src/mainview/styles/tokens.css'
import '../../../src/mainview/index.css'

// Synthetic translation expansion, plus an unbroken-label stress case.
const long = { ...words,
  newVersionAvailable: 'Eine neue Version der KeepKey Vault-Anwendung ist jetzt zum Herunterladen verfügbar',
  downloadingWithProgress: 'Die Aktualisierung der Anwendung wird heruntergeladen: {{progress}} Prozent abgeschlossen',
  downloading: 'Die Aktualisierung der Anwendung wird gerade heruntergeladen, bitte warten',
  readyToInstall: 'Die Aktualisierung wurde vollständig heruntergeladen und ist nun zur Installation bereit',
  applying: 'Die Aktualisierung wird installiert und die Anwendung anschließend neu gestartet',
  later: 'Später daran erinnern', download: 'Aktualisierung jetzt herunterladen',
  restartToUpdate: 'Zum Abschließen der Aktualisierung jetzt neu starten',
}
const stress = { ...long, newVersionAvailable: 'Aktualisierungsbenachrichtigung'.repeat(4), restartToUpdate: 'Anwendungsaktualisierungsneustart'.repeat(3) }
await i18n.use(initReactI18next).init({ lng: 'en', resources: {
  en: { update: words }, long: { update: long }, stress: { update: stress },
}, interpolation: { escapeValue: false } })
const root = createRoot(document.getElementById('root')!)
const qa = (window as any).__updateBanner = {
  calls: [] as string[], words: { en: words, long, stress },
  async render({ phase = 'available', locale = 'en', progress = 65 }: { phase?: string; locale?: string; progress?: number | null } = {}) {
    qa.calls = []
    await i18n.changeLanguage(locale)
    root.render(<ChakraProvider value={system}><UpdateBanner phase={phase as any} progress={progress === null ? undefined : progress}
      message="Version 1.6.11 available" error={undefined}
      onDownload={() => qa.calls.push('download')} onApply={() => qa.calls.push('apply')} onDismiss={() => qa.calls.push('dismiss')} /></ChakraProvider>)
  },
}
