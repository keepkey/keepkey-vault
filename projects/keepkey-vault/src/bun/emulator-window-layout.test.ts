import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('emulator window layout', () => {
  // Keep this test independent from the Electrobun runtime. Importing the
  // window module starts native services, while this regression only needs to
  // guard the document structure and CSS that caused the controls to drift.
  const html = readFileSync(new URL('./emulator-window.ts', import.meta.url), 'utf8')

  test('keeps the OLED, metadata, and buttons in document order', () => {
    const oled = html.indexOf('id="displayArea"')
    const metadata = html.indexOf('id="confirmMeta"')
    const buttons = html.indexOf('id="buttons"')

    expect(oled).toBeGreaterThan(-1)
    expect(metadata).toBeGreaterThan(oled)
    expect(buttons).toBeGreaterThan(metadata)
  })

  test('does not stretch the OLED area to consume window height', () => {
    const displayRule = html.match(/\.display-area\s*\{([^}]*)\}/)?.[1] ?? ''

    expect(displayRule).toContain('flex: 0 0 auto')
    expect(displayRule).toContain('justify-content: flex-start')
    expect(displayRule).not.toMatch(/flex:\s*1(?:;|\s)/)
  })

  test('keeps controls responsive and scrollable in a short or narrow window', () => {
    const bodyRule = html.match(/body\s*\{([^}]*)\}/)?.[1] ?? ''
    const oledRule = html.match(/\.oled\s*\{([^}]*)\}/)?.[1] ?? ''
    const metadataRule = html.match(/\.confirm-meta\s*\{([^}]*)\}/)?.[1] ?? ''
    const buttonsRule = html.match(/\.buttons\s*\{([^}]*)\}/)?.[1] ?? ''

    expect(bodyRule).toContain('overflow-y: auto')
    expect(oledRule).toContain('width: min(320px, calc(100vw - 24px))')
    expect(oledRule).toContain('aspect-ratio: 4 / 1')
    expect(metadataRule).toContain('width: min(320px, calc(100vw - 24px))')
    expect(buttonsRule).toContain('width: min(320px, calc(100vw - 24px))')
  })
})
