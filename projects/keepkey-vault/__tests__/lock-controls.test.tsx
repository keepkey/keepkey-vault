// Lock controls on the dashboard: the header padlock (V19) and the vault button. Chakra is replaced by plain
// elements that keep the styling props, so the test reads what the user would see.
import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const element = (tag: string) => ({ children, as: _as, ...props }: any) => React.createElement(tag,
  Object.fromEntries(Object.entries(props).filter(([, v]) => typeof v === 'string').map(([k, v]) => [/^(aria-|role|title)/.test(k) ? k : `data-${k.toLowerCase()}`, v])), children)
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'), Button: element('button') }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('../src/mainview/i18n/ui', () => ({ useUiTranslation: () => (text: string) => text }))
mock.module('../src/mainview/hooks/usePasswordManagerEnabled', () => ({ usePasswordManagerEnabled: () => true }))
mock.module('../src/mainview/components/Bip85VaultDialog', () => ({ Bip85VaultDialog: () => null }))
mock.module('../src/mainview/components/PasswordBankView', () => ({ PasswordBankView: () => null }))
mock.module('../src/mainview/hooks/usePasskeysEnabled', () => ({ usePasskeysEnabled: () => false }))
mock.module('../src/mainview/components/PasskeysView', () => ({ PasskeysView: () => null }))

describe('locked KeepKey: a padlock in the header, no banner', () => {
  const render = async (unlockError: string | null) => {
    const { HeaderLock } = await import('../src/mainview/components/HeaderLock')
    return renderToStaticMarkup(<HeaderLock unlocking={false} unlockError={unlockError} onUnlock={() => {}} />)
  }
  test('draws a padlock labelled KeepKey locked', async () => {
    const html = await render(null)
    expect(html).toContain('M7 11V7a5 5 0 0 1 10 0v4') // padlock shackle
    expect(html).toContain('aria-label="KeepKey locked"')
  })
  test('an unlock error shows on the padlock', async () => {
    expect(await render('Invalid PIN')).toContain('title="Invalid PIN"')
  })
})

describe('vault tools button', () => {
  // Owner 11-14: the button that opens passwords and the seed vault draws a padlock.
  test('the vault button draws a padlock', async () => {
    const { VaultToolsButton } = await import('../src/mainview/components/VaultToolsButton')
    const html = renderToStaticMarkup(<VaultToolsButton seedVaultAvailable />)
    const icon = html.match(/<svg[\s\S]*?<\/svg>/)?.[0]
    expect(icon).toBeDefined()
    expect(icon).toContain('M7 11V7a5 5 0 0 1 10 0v4') // padlock shackle
    expect(html).toContain('aria-label="Passwords and seed vault"')
  })
})
