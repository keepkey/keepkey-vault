// KEEPKEY-179 (Audit v7 S13): the Passkeys flag and tab showed English in every other
// language, the KeepKey's errors reached the tab in English, and the flag text still
// described the tab before single passkeys could be listed, named and deleted.
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { messageKey } from '../src/shared/message-key'
import { DEVICE_BUSY, PASSKEY_ERRORS, describePasskeyError, parsePasskeyError, passkeyErrorMessage, type PasskeyErrorKind } from '../src/shared/passkey-errors'
import { frames, runReset, type HidLike } from '../src/bun/passkeys'

const app = join(import.meta.dir, '..')
const read = (path: string) => readFileSync(join(app, path), 'utf8')
const locales = join(app, 'src/mainview/i18n/locales')
const LANGUAGES = readdirSync(locales)
const catalog = (language: string, ns: string) => JSON.parse(readFileSync(join(locales, language, `${ns}.json`), 'utf8'))
const KINDS = Object.keys(PASSKEY_ERRORS) as PasskeyErrorKind[]
const sample = (kind: PasskeyErrorKind) => passkeyErrorMessage(kind, /\{code\}/.test(PASSKEY_ERRORS[kind]) ? { code: '0x2b' } : {})

/** i18next-like lookup on one language's device catalog. */
const tFor = (language: string) => {
  const device = catalog(language, 'device')
  return (key: string, options: Record<string, any> = {}) => {
    const value = key.split('.').reduce((o: any, k) => o?.[k], options.ns === 'device' ? device : {})
    return typeof value === 'string' ? value.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => String(options[k])) : key
  }
}

describe('passkey errors (KEEPKEY-179)', () => {
  test('every message reads back as its own kind, with the status byte', () => {
    for (const kind of KINDS) {
      const parsed = parsePasskeyError(sample(kind))
      expect(parsed?.kind).toBe(kind)
      if (/\{code\}/.test(PASSKEY_ERRORS[kind])) expect(parsed?.params).toEqual({ code: '0x2b' })
    }
  })

  test('every kind and the busy text are translated in every language, with the code kept', () => {
    for (const language of LANGUAGES) {
      const t = tFor(language)
      for (const message of [...KINDS.map(sample), DEVICE_BUSY]) {
        const shown = describePasskeyError(message, t)
        expect(shown, `${language}: ${message}`).toBeTruthy()
        expect(shown).not.toMatch(/^passkeys\./)
        if (/0x2b/.test(message)) expect(shown).toContain('0x2b')
      }
    }
    expect(describePasskeyError(passkeyErrorMessage('pinInvalid'), tFor('pt'))).toBe('PIN da chave de segurança incorreto')
  })

  test('any other error is left alone', () => {
    expect(describePasskeyError('socket hang up', tFor('pt'))).toBeNull()
    expect(describePasskeyError('Reset failed (later)', tFor('pt'))).toBeNull()
  })

  test('the bun side throws only texts from the shared list', () => {
    const offenders: string[] = []
    for (const file of ['src/bun/passkeys.ts', 'src/bun/passkeys-manage.ts']) {
      read(file).split('\n').forEach((line, i) => {
        if (/new PasskeyError\(/.test(line) && !/passkeyErrorMessage\(/.test(line)) offenders.push(`${file}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  test('the busy text is the one device-operation and engine-controller throw', () => {
    expect(read('src/bun/device-operation.ts')).toContain(`'${DEVICE_BUSY}'`)
    expect(read('src/bun/engine-controller.ts')).toContain(`'${DEVICE_BUSY}'`)
  })

  test('a reset the KeepKey declines comes out in the shared English text', async () => {
    const CID = 0x01020304
    const out: number[][] = []
    const hid: HidLike = {
      write(d) {
        const p = d.slice(1)
        if (p[4] === 0x86) out.push(...frames(0xffffffff, 0x86, [...p.slice(7, 15), (CID >>> 24) & 255, (CID >>> 16) & 255, (CID >>> 8) & 255, CID & 255, 2, 7, 17, 0, 5]))
        else if (p[4] === 0x90) out.push(...frames(CID, 0x90, [0x27]))
        return d.length
      },
      readTimeout() { return out.shift() ?? [] },
      close() {},
    }
    await expect(runReset(hid)).rejects.toThrow(PASSKEY_ERRORS.resetDeclined)
  })
})

describe('Passkeys flag and tab copy (KEEPKEY-179)', () => {
  const view = read('src/mainview/components/PasskeysView.tsx')
  const drawer = read('src/mainview/components/DeviceSettingsDrawer.tsx')
  const texts = [...view.matchAll(/uiText\('((?:[^'\\]|\\.)*)'/g)].map(m => m[1])
  const flag = 'Experimental. Adds a Passkeys tab to the Vault menu to see, name and delete the passkeys on your KeepKey one by one, or erase them all. Off by default.'

  test('the flag describes what the tab does now', () => {
    expect(drawer).toContain(`uiText("${flag}")`)
    expect(drawer).not.toContain('device status and erasing all passkeys')
    expect(drawer).toContain("uiText('Could not change passkeys')")
    expect(catalog('pt', 'ui')[messageKey(flag)]).toContain('uma a uma')
  })

  test('no sentence on the tab is built from English fragments', () => {
    expect(view).not.toContain("uiText('set')")
    expect(view).not.toContain("uiText('not set')")
    expect(view).not.toContain("uiText('slots used')")
  })

  test('every text on the flag and the tab is translated in every language', () => {
    const missing: string[] = []
    for (const text of new Set([...texts, flag, 'Could not change passkeys', 'Passkeys'])) {
      for (const language of LANGUAGES) if (!catalog(language, 'ui')[messageKey(text)]) missing.push(`${language}: ${text}`)
    }
    expect(missing).toEqual([])
  })

  test('the i18n baseline keeps no debt or hardcoded-text exception for the tab', () => {
    const baseline = JSON.parse(read('scripts/i18n-baseline.json'))
    expect((baseline.rawUi as string[]).filter(id => id.startsWith('components/PasskeysView.tsx:'))).toEqual([])
    const keys = new Set([...texts, flag].map(text => `ui:${messageKey(text)}`))
    expect(Object.keys(baseline.missing).filter(key => keys.has(key))).toEqual([])
  })

  test('PasskeysView in Portuguese: status, list and every error the KeepKey sends', () => {
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, 'support/passkeys-view-pt.tsx')], {
      cwd: app, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
    })
    if (run.exitCode !== 0) throw new Error(run.stderr.toString() || run.stdout.toString())
    expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
      noDevice: 'Interface FIDO da KeepKey não encontrada. Conecte a KeepKey (firmware 7.16 ou mais recente).',
      pinStatus: true,
      // Re-reading the status after a failed action used to clear its error at once.
      pinInvalid: 'PIN da chave de segurança incorreto',
      list: true,
      busy: 'A KeepKey está ocupada com outra solicitação. Espere terminar e tente de novo.',
      unexpectedCode: 'A KeepKey enviou uma resposta inesperada (0x2b). Tente de novo.',
      eraseConfirm: true,
      resetDeclined: 'O apagamento foi recusado na KeepKey',
      other: 'socket hang up',
    })
  }, 35000)
})
