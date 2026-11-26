import { describe, expect, test } from 'bun:test'
import {
  bnFormat, calcStrLineN, calcStrPage, confirmScreens, drawBody, hiveAsset, hiveDeviceMirror, hiveMessageText, hiveSliceScreens, mirrorPosition, mirrorStep,
} from '../src/shared/hive-device-screens'
import { signingReviewGuide } from '../src/shared/signing-review-guide'

const enc = (s: string) => new TextEncoder().encode(s)
const titles = (m: ReturnType<typeof hiveDeviceMirror>) => m!.screens.map(s => s.title)

describe('firmware text layout port (font.c, draw.c, confirm_sm.c @ 378cf30)', () => {
  test('firmware unittest Hive.DisplayPaginationUsesRenderedBodyRows, ported', () => {
    const payload = '%%%%%%%%%%%%%%%% %%%%%%%%%%%%%%%% %%%%%%%%%%%%%%%% %%%%%%%%%%%%%%%%'
    expect(calcStrLineN(payload, payload.length)).toBeGreaterThan(3)
    let offset = 0, pages = 0, rebuilt = ''
    while (offset < payload.length) {
      const rest = payload.slice(offset)
      const take = calcStrPage(rest, rest.length)
      expect(take).toBeGreaterThan(0)
      const page = payload.slice(offset, offset + take)
      expect(calcStrLineN(page, page.length)).toBeLessThanOrEqual(3)
      rebuilt += page; offset += take; pages++
    }
    expect(pages).toBeGreaterThan(1)
    expect(rebuilt).toBe(payload)
  })

  test('word wrap at 225 px with the body font widths; leading spaces dropped', () => {
    // '%' is 8 px: a 16-glyph word is 128 px, and a second one (+4 px space) no longer fits the row.
    expect(drawBody('%%%%%%%%%%%%%%%% %%%%%%%%%%%%%%%%').rows).toEqual(['%%%%%%%%%%%%%%%%', '%%%%%%%%%%%%%%%%'])
    // A word wider than the row breaks between glyphs.
    expect(drawBody('W'.repeat(30)).rows).toEqual(['W'.repeat(28), 'WW'])
    expect(drawBody('a\nb\nc\nd').fits).toBe(false) // a fourth row is below the canvas
  })

  test('confirm() pages a body that does not fit, titled n/N, one screen per ButtonRequest', () => {
    const body = 'word '.repeat(40).trim()
    const screens = confirmScreens('Title', body)!
    expect(screens.length).toBeGreaterThan(1)
    expect(screens.map(s => s.title)).toEqual(screens.map((_, i) => `Title ${i + 1}/${screens.length}`))
    expect(screens.every(s => s.rows.length <= 3)).toBe(true)
    // page_take keeps the longest prefix that fits, so a page may end mid-word ("wor" | "d").
    expect(screens.flatMap(s => s.rows).join('').replace(/ /g, '')).toBe(body.replace(/ /g, ''))
  })

  test('amounts print without trailing zeros (bn_format trailing=false), STEEM/SBD shown as HIVE/HBD', () => {
    expect(bnFormat(1500n, 3)).toBe('1.5')
    expect(bnFormat(1000n, 3)).toBe('1')
    expect(hiveAsset('1.000 STEEM')).toBe('1 HIVE')
    expect(hiveAsset('0.250 HBD')).toBe('0.25 HBD')
    expect(hiveAsset('1234.567890 VESTS')).toBe('1234.56789 VESTS')
    expect(hiveAsset('1.5 HIVE')).toBeNull() // wrong precision: not something the device would sign
  })

  test('non-printable slices page as hex', () => {
    const s = hiveSliceScreens('Custom JSON', new Uint8Array([0x7b, 0xe2, 0x82, 0xac, 0x7d]))!
    expect(s).toEqual([{ title: 'Custom JSON Hex 1/1', rows: ['7be282ac7d'] }])
  })
})

describe('Hive requests, screen by screen', () => {
  test('sign-message (KeepKey Client login): key screen, then the full text', () => {
    const m = hiveDeviceMirror('/hive/sign-message', { message: 'Login to peakd.com 1732600000' })!
    expect(m.exact).toBe(true)
    expect(m.screens).toEqual([
      { title: 'Sign Hive Message', rows: ['Signing with posting key'] },
      { title: 'Hive Message', rows: ['Login to peakd.com 1732600000'] },
    ])
  })

  test('sign-message, long text: paged exactly where calc_str_page cuts (mid-word included)', () => {
    const text = 'This is a long KeepKey Client login challenge for @vladtest. Nonce 7f3a9c21-4b8e-4d2a-9f11-0c6e5b2d8a77 issued at 2026-11-26T14:03:11Z for keepkey.info. Sign only if you started this login.'
    const m = hiveDeviceMirror('/hive/sign-message', { message: text, address_n: [0x80000030, 0x8000000d, 0x80000001, 0x80000000, 0x80000000] })!
    expect(titles(m)).toEqual(['Sign Hive Message', 'Hive Message 1/2', 'Hive Message 2/2'])
    expect(m.screens[0]!.rows).toEqual(['Signing with active key'])
    expect(m.screens[1]!.rows).toEqual(['This is a long KeepKey Client login challenge', 'for @vladtest. Nonce', '7f3a9c21-4b8e-4d2a-9f11-0c6e5b2d8a77 iss'])
    expect(m.screens[2]!.rows).toEqual(['ued at 2026-11-26T14:03:11Z for keepkey.info.', 'Sign only if you started this login.'])
  })

  test('sign-message the device refuses (non-printable): no screens, the reason instead', () => {
    const m = hiveDeviceMirror('/hive/sign-message', { message: 'olá' })!
    expect(m.screens).toHaveLength(0)
    expect(m.reason).toMatch(/printable text/)
  })

  test('vote', () => {
    const m = hiveDeviceMirror('/hive/sign-operations', { operations: [['vote', { voter: 'vladtest', author: 'skatehive', permlink: 'the-weekly-session-recap-week-47', weight: 5000 }]] })!
    expect(m.screens).toEqual([
      { title: 'Vote', rows: ['@vladtest -> @skatehive at 50.00%'] },
      { title: 'Vote Target', rows: ['the-weekly-session-recap-week-47'] },
      { title: 'Sign Transaction', rows: ['Sign 1 Hive operation with the posting key?'] },
    ])
    expect(hiveDeviceMirror('/hive/sign-operations', { operations: [['vote', { voter: 'a', author: 'b', permlink: 'p', weight: -10000 }]] })!.screens[0]!.title).toBe('Downvote')
  })

  test('custom_json: each auth, the id, the full JSON, then the key tier', () => {
    const json = '["follow",{"follower":"vladtest","following":"skatehive","what":["blog"]}]'
    const m = hiveDeviceMirror('/hive/sign-operations', { operations: [['custom_json', { required_auths: [], required_posting_auths: ['vladtest'], id: 'follow', json }]] })!
    expect(titles(m)).toEqual(['Custom JSON Auth', 'Custom JSON ID', 'Custom JSON', 'Sign Transaction'])
    expect(m.screens[0]!.rows).toEqual(['1/1: @vladtest', 'Posting key'])
    expect(m.screens[2]!.rows.join('')).toBe(json)
    const active = hiveDeviceMirror('/hive/sign-operations', { operations: [['custom_json', { required_auths: ['vladtest'], required_posting_auths: [], id: 'vsc.call', json: '{}' }]] })!
    expect(active.screens[0]!.rows[1]).toBe('Active key')
    expect(active.screens.at(-1)!.rows).toEqual(['Sign 1 Hive operation with the active key?'])
  })

  test('transfer (HiveSignTx): amount as printed, memo escaped by confirm_bytes, contact screen flagged', () => {
    const m = hiveDeviceMirror('/hive/sign-transfer', { from: 'vladtest', to: 'skatehive', amount: 1500, asset_symbol: 'HBD', memo: 'thanks for the session' })!
    expect(m.screens).toEqual([
      { title: 'Send Hive', rows: ['Send 1.5 HBD to @skatehive?'] },
      { title: 'Memo', rows: ['thanks\\x20for\\x20the\\x20session'] },
      { title: 'Sign Transaction', rows: ['Sign Hive transaction from @vladtest?'] },
    ])
    expect(m.mayPrepend).toBe('certified-contact')
  })

  test('comment + comment_options with beneficiaries', () => {
    const m = hiveDeviceMirror('/hive/sign-operations', { operations: [
      ['comment', { parent_author: '', parent_permlink: 'hive-173115', author: 'vladtest', permlink: 'my-line', title: 'My line', body: 'Kickflip.', json_metadata: '' }],
      ['comment_options', { author: 'vladtest', permlink: 'my-line', max_accepted_payout: '1000000.000 HBD', percent_hbd: 10000, allow_votes: true, allow_curation_rewards: true, extensions: [[0, { beneficiaries: [{ account: 'skatehive', weight: 500 }] }]] }],
    ] })!
    expect(titles(m)).toEqual(['Post', 'Post Category', 'Post Permlink', 'Post Title', 'Post Body', 'Payout Options', 'Payout Options', 'Payout Beneficiary', 'Payout Permlink', 'Sign Transaction'])
    expect(m.screens[5]!.rows).toEqual(['@vladtest', 'Max 1000000 HBD', 'HBD split 100.00%'])
    expect(m.screens[7]!.rows).toEqual(['1/1: @skatehive', 'gets 5.00%'])
    expect(m.screens.at(-1)!.rows).toEqual(['Sign 2 Hive operations with the posting', 'key?'])
  })

  test('a custom chain id adds its consent screen first', () => {
    const m = hiveDeviceMirror('/hive/sign-operations', { chain_id: '1'.repeat(64), operations: [['vote', { voter: 'a', author: 'b', permlink: 'p', weight: 100 }]] })!
    expect(m.screens[0]!.title).toBe('Custom Hive chain')
  })

  test('follows the device: screen = ButtonRequests seen - 1, clamped', () => {
    const m = hiveDeviceMirror('/hive/sign-message', { message: 'hi' })!
    expect([0, 1, 2, 9].map(n => mirrorStep(m, n))).toEqual([0, 0, 1, 1])
  })

  test('unknown op: reported as not reproducible, never guessed', () => {
    const m = hiveDeviceMirror('/hive/sign-operations', { operations: [['witness_update', {}]] })!
    expect(m.exact).toBe(false)
    expect(m.reason).toMatch(/witness_update/)
  })
})

describe('review guide reads Hive message text', () => {
  test('text message shows its text; hex is decoded when it is UTF-8', () => {
    const g = signingReviewGuide({ id: '1', method: '/hive/sign-message', appName: 'KeepKey Client', rawRequestBody: { message: 'Login to peakd.com 1732600000' } } as any)
    expect(g.fields).toContainEqual({ label: 'Message', value: 'Login to peakd.com 1732600000' })
    expect(g.fields).toContainEqual({ label: 'Network', value: 'Hive' })
    expect(g.warnings.join(' ')).not.toMatch(/Readable message text is unavailable/)
    expect(g.noFundsMove).toBe(true)
    expect(hiveMessageText({ message: Buffer.from('hello').toString('hex'), is_text: false })).toBe('hello')
    expect(hiveMessageText({ message: 'ff', is_text: false })).toBeNull()
  })
})

// skatehive.app profile edit, as logged by the vault (6 × "[Engine] BUTTON_REQUEST").
const PROFILE_UPDATE = { operations: [['account_update2', {
  account: 'sopadevs',
  json_metadata: '{"profile":{},"extensions":{"wallets":{"additional":[],"primary_wallet":"","btc_address":""},"settings":{"voteSettings":{"default_voting_weight":5100,"enable_slider":true},"appSettings":{"zineCover":"","svs_profile":""}},"other":{},"video_parts":[]}}',
  posting_json_metadata: '{"profile":{"name":"sopadevs","about":"","location":"","cover_image":"","profile_image":"https://ipfs.skatehive.app/ipfs/bafkreib3vjph33zmrsw5xpdnvhd7yc26h3i6vykhi6snmfkzr5vjszjohy?filename=skatehive.png","website":"","instagram":"","version":2}}',
  extensions: [],
}]] }

describe('following the device, ButtonRequest by ButtonRequest', () => {
  test('account_update2 profile edit: 6 confirm() calls (each slice page is its own), 6 ButtonRequests, 6 screens', () => {
    const m = hiveDeviceMirror('/hive/sign-operations', PROFILE_UPDATE)!
    expect(titles(m)).toEqual(['Profile Update', 'Account Metadata 1/2', 'Account Metadata 2/2', 'Profile Metadata 1/2', 'Profile Metadata 2/2', 'Sign Transaction'])
    expect(m.contactBefore).toBeUndefined()
    expect([1, 2, 3, 4, 5, 6].map(n => mirrorPosition(m, n))).toEqual([0, 1, 2, 3, 4, 5].map(i => ({ from: i, to: i })))
    expect(mirrorPosition(m, 7)).toEqual({ from: 5, to: 5, beyond: true })
  })

  test('a transfer to a possible certified contact: one screen, then a range once the contact screen may have been shown', () => {
    const m = hiveDeviceMirror('/hive/sign-transfer', { from: 'vladtest', to: 'skatehive', amount: 1500, asset_symbol: 'HBD', memo: 'thanks for the session' })!
    expect(m.contactBefore).toEqual([0])
    expect(mirrorPosition(m, 1)).toEqual({ from: 0, to: 0 }) // contact screen or "Send Hive": shown as "Send Hive"
    expect(mirrorPosition(m, 2)).toEqual({ from: 0, to: 1 })
    expect(mirrorPosition(m, 3)).toEqual({ from: 1, to: 2 })
    expect(mirrorPosition(m, 4)).toEqual({ from: 2, to: 2 }) // only possible with the contact screen
    expect(mirrorPosition(m, 5).beyond).toBe(true)
  })

  test('vote then a power-up to another account: the contact slot sits before the power-up, so the vote screens stay exact', () => {
    const m = hiveDeviceMirror('/hive/sign-operations', { operations: [
      ['vote', { voter: 'vladtest', author: 'skatehive', permlink: 'p', weight: 10000 }],
      ['transfer_to_vesting', { from: 'vladtest', to: 'skatehive', amount: '1.000 HIVE' }],
    ] })!
    expect(m.contactBefore).toEqual([2])
    expect([1, 2, 3].map(n => mirrorPosition(m, n))).toEqual([{ from: 0, to: 0 }, { from: 1, to: 1 }, { from: 2, to: 2 }])
    expect(mirrorPosition(m, 4)).toEqual({ from: 2, to: 3 })
  })

  test('no contact screen off mainnet', () => {
    const m = hiveDeviceMirror('/hive/sign-transfer', { from: 'a', to: 'b', amount: 1, chain_id: '1'.repeat(64) })!
    expect(m.mayPrepend).toBeUndefined()
    expect(m.contactBefore).toBeUndefined()
  })
})
