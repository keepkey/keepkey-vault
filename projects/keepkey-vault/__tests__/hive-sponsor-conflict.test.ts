// A 409 from the Hive sponsor used to read "This device already has a sponsored
// Hive account." for any ETH/address text — including when the limit hit was
// this vault installation (Pioneer "client"), on a freshly set up KeepKey.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import i18next from 'i18next'
import { messageKey } from '../src/shared/message-key'
import { classifyHiveSponsorConflict, offersExistingAccount } from '../src/mainview/lib/hive-sponsor-conflict'
import { buildAccountCreateOp, buildCreateClaimedAccountOp, buildKeyRotationOp, hiveSignerUrl, parseAccountAuthorities } from '../src/shared/hive-onboarding'

describe('classifyHiveSponsorConflict', () => {
  test('maps every server text Pioneer sends today', () => {
    expect(classifyHiveSponsorConflict('Username already registered')).toBe('name-taken')
    expect(classifyHiveSponsorConflict('This ETH address already has a sponsored Hive account')).toBe('eth-address')
    // Production folds the address and installation limits into one sentence.
    expect(classifyHiveSponsorConflict('This ETH address or client has already claimed a sponsored Hive account')).toBe('eth-or-client')
  })

  test('recognizes an installation-only limit', () => {
    expect(classifyHiveSponsorConflict('This client has already claimed a sponsored Hive account')).toBe('client')
    expect(classifyHiveSponsorConflict('Query key already used for a sponsored account')).toBe('client')
  })

  test('unknown or empty text keeps the historical name-taken fallback', () => {
    expect(classifyHiveSponsorConflict(undefined)).toBe('name-taken')
    expect(classifyHiveSponsorConflict('')).toBe('name-taken')
    expect(classifyHiveSponsorConflict('Conflict')).toBe('name-taken')
  })

  test('"eth" inside another word is not an ETH address', () => {
    expect(classifyHiveSponsorConflict('Something went wrong')).toBe('name-taken')
  })

  test('only the installation limit offers an existing account', () => {
    expect(offersExistingAccount('client')).toBe(true)
    expect(offersExistingAccount('eth-or-client')).toBe(true)
    expect(offersExistingAccount('eth-address')).toBe(false)
    expect(offersExistingAccount('name-taken')).toBe(false)
    expect(offersExistingAccount(null)).toBe(false)
  })
})

describe('HiveAccountPanel 409 copy', () => {
  // One run of the real-panel fixture (it waits on debounces and the 3s watcher tick).
  let cached: any
  const harness = () => {
    if (cached) return cached
    const run = Bun.spawnSync([process.execPath, new URL('./support/hive-sponsor-conflict.tsx', import.meta.url).pathname], {
      cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 60000,
    })
    if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
    return (cached = JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!))
  }

  test('the real wizard shows the right message per conflict and never blames the device', () => {
    const out = harness()

    expect(out.name).toEqual({ conflict: null, message: null, nameTaken: true, blamesDevice: false, offersExisting: false, opensBring: false, choiceShown: true })
    expect(out.eth).toMatchObject({ conflict: 'eth-address', nameTaken: false, blamesDevice: false, offersExisting: false })
    expect(out.eth.message).toContain("This KeepKey's Ethereum address already claimed")
    expect(out.client).toMatchObject({ conflict: 'client', nameTaken: false, blamesDevice: false, offersExisting: true, opensBring: true })
    expect(out.client.message).toContain('This copy of KeepKey Vault already created')
    expect(out.production).toMatchObject({ conflict: 'eth-or-client', nameTaken: false, blamesDevice: false, offersExisting: true, opensBring: true })
    expect(out.production.message).toContain('either by this KeepKey')
  }, 60000)

  test('after a refusal, path A builds the op, opens HiveSigner and resolves once the account exists', () => {
    const out = harness()
    // Mocked device keys (hiveGetRoleKeys in the fixture).
    const keys = { owner: 'STM1', active: 'STM2', posting: 'STM3', memo: 'STM4' }

    expect(out.payWithHive).toMatchObject({ panelShown: true, prefilledName: 'sopatest', op: 'account_create', qr: true, waiting: true, resolved: true })
    expect(out.payWithHive.opened).toEqual([hiveSignerUrl(buildAccountCreateOp({ creator: 'skatehive', newAccountName: 'sopatest', keys, fee: '3.000 HIVE' }))])

    // A payer holding account-creation tokens spends one instead of HIVE (default on).
    expect(out.payWithToken).toMatchObject({ panelShown: true, op: 'create_claimed_account', resolved: true })
    expect(out.payWithToken.opened).toEqual([hiveSignerUrl(buildCreateClaimedAccountOp({ creator: 'tokenrich', newAccountName: 'sopatest', keys }))])
  }, 60000)

  test('path B: "Use it with your KeepKey" reviews the rotation and opens the exact account_update', () => {
    const out = harness()
    const keys = { owner: 'STM1', active: 'STM2', posting: 'STM3', memo: 'STM4' }
    const account = parseAccountAuthorities({ name: 'sopadev', memo_key: 'STM8old', json_metadata: '{"profile":{"name":"Sopa"}}',
      owner: { weight_threshold: 1, account_auths: [], key_auths: [['STM5old', 1]] },
      active: { weight_threshold: '1', account_auths: [], key_auths: [['STM6old', '1']] },
      posting: { weight_threshold: 1, account_auths: [['peakd.app', '1'], ['ecency.app', 1]], key_auths: [['STM7old', 1]] } })

    expect(out.bringKeepApps).toMatchObject({ bringShown: true, appsListed: true, op: 'account_update', ownerOffered: true, resolved: true })
    expect(out.bringKeepApps.rows).toEqual(expect.arrayContaining(['Active key → this KeepKey', 'Posting key → this KeepKey', 'Memo key → this KeepKey', 'Owner key stays as it is', 'Apps with posting access']))
    expect(out.bringKeepApps.opened).toEqual([hiveSignerUrl(buildKeyRotationOp(account, keys, { keepPostingAccountAuths: true, keepActiveAccountAuths: true }))])
    // Unticking "Keep ecency.app, peakd.app" drops them from posting.
    expect(out.bringDropApps.opened).toEqual([hiveSignerUrl(buildKeyRotationOp(account, keys, { keepPostingAccountAuths: false, keepActiveAccountAuths: true }))])
    expect(out.bringDropApps.opened).not.toEqual(out.bringKeepApps.opened)
  }, 60000)
})

describe('HiveAccountPanel 409 translations', () => {
  const dir = join(import.meta.dir, '../src/mainview/i18n/locales')
  const ui = (locale: string) => JSON.parse(readFileSync(join(dir, locale, 'ui.json'), 'utf8')) as Record<string, string>
  const panel = readFileSync(join(import.meta.dir, '../src/mainview/components/HiveAccountPanel.tsx'), 'utf8')
  const SOURCES = [...panel.matchAll(/uiText\("((?:[^"\\]|\\.)*)"\)/g)].map(m => m[1])
    .filter(s => /Ethereum address already|copy of KeepKey Vault|free Hive account was already|Already have a Hive|Use it with your KeepKey/.test(s))

  test('the conflict strings are wired through uiText; the "coming soon" placeholder is gone', () => {
    expect(SOURCES.length).toBe(5)
    expect(panel).not.toContain('Coming soon')
    expect(panel).not.toContain('This device already has a sponsored Hive account')
  })

  test('every locale translates every new string (no English fallback)', () => {
    const en = ui('en')
    for (const source of SOURCES) expect(en[messageKey(source)]).toBe(source)
    for (const locale of readdirSync(dir).filter(l => l !== 'en')) {
      const local = ui(locale)
      for (const source of SOURCES) {
        const text = local[messageKey(source)]
        expect(typeof text, `${locale}: ${source}`).toBe('string')
        expect(text, `${locale}: ${source}`).not.toBe(source)
      }
    }
  })

  test('Portuguese reads naturally', async () => {
    const i18n = i18next.createInstance()
    await i18n.init({ lng: 'pt', resources: { pt: { ui: ui('pt') } }, interpolation: { escapeValue: false } })
    expect(i18n.t(messageKey('Already have a Hive account?'), { ns: 'ui' })).toBe('Já tem uma conta Hive?')
    expect(i18n.t(messageKey('Use it with your KeepKey'), { ns: 'ui' })).toBe('Use-a com a KeepKey')
  })
})
