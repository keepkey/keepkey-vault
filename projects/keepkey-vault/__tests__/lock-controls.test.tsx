// Lock controls on the dashboard (audit v4 V18, V19). Chakra is replaced by plain
// elements that keep the styling props, so the test reads what the user would see.
import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const element = (tag: string) => ({ children, as: _as, ...props }: any) => React.createElement(tag,
  Object.fromEntries(Object.entries(props).filter(([, v]) => typeof v === 'string').map(([k, v]) => [/^(aria-|role|title)/.test(k) ? k : `data-${k.toLowerCase()}`, v])), children)
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'), Button: element('button') }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('../src/mainview/i18n/ui', () => ({ useUiTranslation: () => (text: string) => text }))

describe('locked-portfolio banner (V19)', () => {
  test('Unlock is the primary action, not the smallest outline button', async () => {
    const { LockedPortfolioBanner } = await import('../src/mainview/components/LockedPortfolioBanner')
    const html = renderToStaticMarkup(<LockedPortfolioBanner unlocking={false} unlockError={null} onUnlock={() => {}} />)
    const unlock = html.match(/<button[^>]*>pin\.unlock<\/button>/)?.[0]
    expect(unlock).toBeDefined()
    expect(unlock).toContain('data-variant="solid"')
    expect(unlock).toContain('data-size="sm"')
    expect(unlock).toContain('data-bg="var(--gold)"')
    expect(html).toContain('KeepKey locked')
  })
  test('shows the unlock error under the label', async () => {
    const { LockedPortfolioBanner } = await import('../src/mainview/components/LockedPortfolioBanner')
    expect(renderToStaticMarkup(<LockedPortfolioBanner unlocking={false} unlockError="Invalid PIN" onUnlock={() => {}} />)).toContain('Invalid PIN')
  })
})
