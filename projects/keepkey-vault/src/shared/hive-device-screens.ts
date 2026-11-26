/**
 * What a KeepKey's OLED shows, screen by screen, while it signs a Hive
 * request — computed, not sketched.
 *
 * Source: BitHighlander/keepkey-firmware at the 7.17.0 alpha 378cf30, the
 * build on the devices that sign Hive operations:
 *  - lib/firmware/fsm_msg_hive.h  titles, format strings, screen order
 *  - lib/firmware/hive.c          op fields, tier, asset symbols
 *  - lib/board/confirm_sm.c       confirm(): one ButtonRequest, then paging
 *                                 (page_take / page_body_confirm) when the
 *                                 body does not fit the canvas
 *  - lib/board/draw.c             draw_string_walk(): word wrap and fit
 *  - lib/board/font.c             body font widths, calc_str_line_n/page
 *  - lib/firmware/app_confirm.c   confirm_bytes(): escaped byte pages
 *  - trezor-crypto bn_format      amounts without trailing zeros
 *
 * Every function here is a port of the code above, not a model of it: the
 * same widths, the same wrap test, the same page splits. A screen in the
 * result is exactly one ButtonRequest from the device, in order, so the
 * vault can follow along as the requests arrive.
 *
 * Two things the host cannot know, reported per request instead of guessed:
 * a certified-contact screen (only when the recipient is in the device's
 * signed contact book) and a custom-chain screen (only off mainnet).
 */

// ── Canvas and font (layout.h, font.c) ──────────────────────────────

const CANVAS_W = 256
const CANVAS_H = 64
const LEFT_MARGIN = 4
const BODY_WIDTH = 225
const BODY_ROWS = 3
const BODY_CHAR_MAX = 352
const FONT_H = 10
const BODY_TOP_MARGIN = 7
const LINE_H = FONT_H + 4 // font height + BODY_FONT_LINE_PADDING
/** Body font widths for ' '..'~' (font.c body_font_array). */
const BODY_WIDTHS = '42476873336636386366666666335656866666666466686666666668666484463666665662352866665656686665257'
const SADFACE_W = 9 // font_get_char() fallback glyph

function glyphW(c: string): number {
  const i = c.charCodeAt(0) - 0x20
  return i >= 0 && i < BODY_WIDTHS.length ? Number(BODY_WIDTHS[i]) : SADFACE_W
}

/** calc_str_line_n(): the line model used for alignment and Hive paging. */
export function calcStrLineN(s: string, len: number, width = BODY_WIDTH): number {
  let lines = 1, x = 0, i = 0
  while (i < len && i < s.length) {
    const cw = glyphW(s[i]!)
    let ww = cw
    if (s[i] === '\n') { lines++; x = 0; i++; continue }
    if (s[i] === ' ') {
      for (let j = i + 1; j < len && j < s.length && s[j] !== ' ' && s[j] !== '\n'; j++) ww += glyphW(s[j]!)
    }
    if (x + ww > width) { lines++; x = 0 }
    if (x === 0 && s[i] === ' ') { i++; continue }
    x += cw
    i++
  }
  return lines
}

/** calc_str_page(): how many characters fit within maxLines. */
export function calcStrPage(s: string, len: number, width = BODY_WIDTH, maxLines = BODY_ROWS): number {
  let best = 0
  for (let take = 1; take <= len; take++) {
    if (calcStrLineN(s, take, width) > maxLines) break
    best = take
  }
  return best
}

/** draw_string_walk() as placed by layout_standard_notification(): the rows
 *  actually drawn, and whether every character was placed. */
export function drawBody(body: string, width = BODY_WIDTH): { fits: boolean; rows: string[] } {
  const lines = calcStrLineN(body, body.length, width)
  let y = (lines === 1 ? 20 : lines === 2 ? 13 : 7) + FONT_H + BODY_TOP_MARGIN
  const rows: string[] = ['']
  let x = 0, i = 0
  const trim = () => { while (rows.length > 1 && rows[rows.length - 1] === '') rows.pop() }
  while (i < body.length) {
    const c = body[i]!
    const cw = glyphW(c)
    if (c === '\n') {
      y += LINE_H; x = 0; i++; rows.push('')
      if (y + FONT_H > CANVAS_H) { trim(); return { fits: false, rows } }
      continue
    }
    let ww = cw
    if (c === ' ') for (let j = i + 1; j < body.length && body[j] !== ' ' && body[j] !== '\n'; j++) ww += glyphW(body[j]!)
    if (x + ww > width) { y += LINE_H; x = 0; rows.push('') }
    if (x === 0 && c === ' ') { i++; continue }
    if (LEFT_MARGIN + x + cw > CANVAS_W || y + FONT_H > CANVAS_H) { trim(); return { fits: false, rows } }
    rows[rows.length - 1] += c
    x += cw
    i++
  }
  trim()
  return { fits: true, rows }
}

/** page_take(): the longest prefix the renderer places completely. */
function pageTake(body: string): number {
  if (!body.length) return 0
  let lo = 1, hi = Math.min(body.length, BODY_CHAR_MAX - 1), best = 1
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (drawBody(body.slice(0, mid)).fits) { best = mid; lo = mid + 1 }
    else { if (mid === 1) break; hi = mid - 1 }
  }
  return best
}

export interface OledScreen {
  title: string
  rows: string[]
}

/** confirm(): one screen when the body fits, else page_body_confirm pages
 *  titled "Title n/N" (each its own ButtonRequest). Null when the firmware
 *  refuses to format the body at all. */
export function confirmScreens(title: string, body: string): OledScreen[] | null {
  if (body.length >= BODY_CHAR_MAX) return null
  const whole = drawBody(body)
  if (whole.fits) return [{ title, rows: whole.rows }]
  const takes: number[] = []
  for (let p = 0; p < body.length;) {
    const take = pageTake(body.slice(p))
    if (take === 0) break
    takes.push(take)
    p += take
    while (body[p] === ' ') p++
    if (takes.length > 99) return null
  }
  // One page: drawn as it was, clipped (the firmware's own behaviour).
  if (takes.length <= 1) return [{ title, rows: whole.rows }]
  const out: OledScreen[] = []
  let p = 0
  takes.forEach((take, n) => {
    out.push({ title: `${title} ${n + 1}/${takes.length}`, rows: drawBody(body.slice(p, p + take)).rows })
    p += take
    while (body[p] === ' ') p++
  })
  return out
}

const isPrintable = (b: number) => b >= 0x20 && b <= 0x7e
const hex2 = (b: number) => b.toString(16).padStart(2, '0')

/** hive_confirm_slice(): a user string paged in full, as text or as hex. */
export function hiveSliceScreens(title: string, bytes: Uint8Array): OledScreen[] | null {
  if (bytes.length === 0) return confirmScreens(title, '(empty)')
  const ascii = bytes.every(isPrintable)
  const pageLen = (off: number) => {
    const rest = bytes.length - off
    if (ascii) {
      const cand = Math.min(rest, BODY_CHAR_MAX - 1)
      const s = String.fromCharCode(...bytes.subarray(off, off + cand))
      return calcStrPage(s, cand)
    }
    const cand = Math.min(rest, Math.floor((BODY_CHAR_MAX - 1) / 2))
    const h = Array.from(bytes.subarray(off, off + cand), hex2).join('')
    return Math.floor(calcStrPage(h, 2 * cand) / 2)
  }
  const takes: number[] = []
  for (let off = 0; off < bytes.length;) {
    const take = pageLen(off)
    if (take === 0) return null
    takes.push(take)
    off += take
  }
  const out: OledScreen[] = []
  let off = 0
  for (let n = 0; n < takes.length; n++) {
    const slice = bytes.subarray(off, off + takes[n]!)
    const pageTitle = takes.length > 1 || !ascii ? (ascii ? `${title} ${n + 1}/${takes.length}` : `${title} Hex ${n + 1}/${takes.length}`) : title
    const rendered = ascii ? String.fromCharCode(...slice) : Array.from(slice, hex2).join('')
    const screens = confirmScreens(pageTitle, rendered)
    if (!screens) return null
    out.push(...screens)
    off += takes[n]!
  }
  return out
}

/** confirm_bytes(): bytes escaped (\xHH outside 0x21..0x7e and for '\'),
 *  paged on the line model. */
export function confirmBytesScreens(title: string, bytes: Uint8Array): OledScreen[] | null {
  if (bytes.length === 0) return confirmScreens(title, '(no data)')
  const token = (b: number) => (b >= 0x21 && b <= 0x7e && b !== 0x5c ? String.fromCharCode(b) : `\\x${b.toString(16).toUpperCase().padStart(2, '0')}`)
  const pages: string[] = []
  for (let off = 0; off < bytes.length;) {
    let out = '', used = 0
    while (off + used < bytes.length) {
      const t = token(bytes[off + used]!)
      if (out.length + t.length > BODY_CHAR_MAX - 1) break
      if (calcStrLineN(out + t, (out + t).length) > BODY_ROWS) break
      out += t
      used++
    }
    if (used === 0) return null
    pages.push(out)
    off += used
  }
  const screens: OledScreen[] = []
  for (let n = 0; n < pages.length; n++) {
    const s = confirmScreens(pages.length === 1 ? title : `${title} ${n + 1}/${pages.length}`, pages[n]!)
    if (!s) return null
    screens.push(...s)
  }
  return screens
}

// ── Values as the firmware prints them ──────────────────────────────

/** bn_format(..., trailing=false): "1.500" -> "1.5", "1.000" -> "1". */
export function bnFormat(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString()
  const d = 10n ** BigInt(decimals)
  const frac = (amount % d).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${amount / d}.${frac}` : `${amount / d}`
}

const SYMBOL_PRECISION: Record<string, number> = { HIVE: 3, HBD: 3, VESTS: 6, STEEM: 3, SBD: 3 }
const DISPLAY_SYMBOL: Record<string, string> = { STEEM: 'HIVE', SBD: 'HBD' }

/** "1.500 HIVE" (condenser JSON) -> "1.5 HIVE" (hive_format_asset). */
export function hiveAsset(text: unknown): string | null {
  const m = /^\s*(\d+)(?:\.(\d+))?\s+([A-Z]+)\s*$/.exec(String(text ?? ''))
  if (!m) return null
  const symbol = m[3]!
  const prec = SYMBOL_PRECISION[symbol]
  if (prec === undefined || (m[2] ?? '').length !== prec) return null
  const raw = BigInt(m[1]! + (m[2] ?? ''))
  return `${bnFormat(raw, prec)} ${DISPLAY_SYMBOL[symbol] ?? symbol}`
}

const assetIsZero = (text: unknown) => /^\s*0+(?:\.0+)?\s/.test(String(text ?? ''))
const pct = (bp: number) => `${Math.trunc(bp / 100)}.${String(Math.abs(bp % 100)).padStart(2, '0')}%`
const utf8 = (s: unknown) => new TextEncoder().encode(String(s ?? ''))

// ── Requests ────────────────────────────────────────────────────────

export interface DeviceMirror {
  /** Every screen is the device's own, in order (one per ButtonRequest). */
  exact: boolean
  screens: OledScreen[]
  /** Screens the device may add that the host cannot predict. */
  mayPrepend?: 'certified-contact' | 'contact-address'
  /** Screen indices a "Certified contact" screen may precede (one ButtonRequest
   *  each, only when that recipient is in the device's contact book). */
  contactBefore?: number[]
  /** Why the mirror is not exact, when it is not. */
  reason?: string
}

const H = 0x80000000
const ROLE_OF: Record<number, 'active' | 'memo' | 'posting'> = { 1: 'active', 3: 'memo', 4: 'posting' }
const POSTING_PATH_ROLE = 4

/** HiveSignMessage: "Sign Hive Message" + the full message, paged. */
export function hiveSignMessageMirror(body: { message?: unknown; is_text?: unknown; address_n?: unknown; addressNList?: unknown }): DeviceMirror | null {
  const path = (Array.isArray(body.addressNList) ? body.addressNList : Array.isArray(body.address_n) ? body.address_n : null) as number[] | null
  const roleIndex = path ? Number(path[2]) - H : POSTING_PATH_ROLE
  const role = ROLE_OF[roleIndex]
  if (!role || typeof body.message !== 'string') return null
  const bytes = body.is_text === false
    ? Uint8Array.from((body.message.replace(/^0x/, '').match(/../g) ?? []).map(h => parseInt(h, 16)))
    : utf8(body.message)
  // The device refuses anything but printable ASCII before showing a screen.
  if (!bytes.length || !bytes.every(isPrintable)) return { exact: true, screens: [], reason: 'The KeepKey refuses this message: Hive messages must be printable text.' }
  const head = confirmScreens('Sign Hive Message', `Signing with ${role} key`)
  const text = hiveSliceScreens('Hive Message', bytes)
  if (!head || !text) return null
  return { exact: true, screens: [...head, ...text] }
}

/** HiveSignTx (/hive/sign-transfer): send, memo, sign. */
export function hiveSignTransferMirror(body: { from?: unknown; to?: unknown; amount?: unknown; asset_symbol?: unknown; memo?: unknown; chain_id?: unknown }): DeviceMirror | null {
  if (typeof body.amount !== 'number' || typeof body.to !== 'string' || typeof body.from !== 'string') return null
  const symbol = body.asset_symbol === 'HBD' ? 'HBD' : 'HIVE'
  const screens: OledScreen[] = [...chainScreens(body.chain_id)]
  const contactAt = screens.length // contact_book_confirm_address runs right before "Send Hive"
  const push = (s: OledScreen[] | null) => { if (!s) throw new Error('unformattable'); screens.push(...s) }
  try {
    push(confirmScreens('Send Hive', `Send ${bnFormat(BigInt(body.amount), 3)} ${symbol} to @${body.to}?`))
    if (typeof body.memo === 'string' && body.memo.length > 0) push(confirmBytesScreens('Memo', utf8(body.memo)))
    push(confirmScreens('Sign Transaction', `Sign Hive transaction from @${body.from}?`))
  } catch { return null }
  // The contact book is consulted on mainnet only.
  if (contactAt) return { exact: true, screens }
  return { exact: true, screens, mayPrepend: 'certified-contact', contactBefore: [contactAt] }
}

type Op = [string, Record<string, any>]

/** One operation's screens (fsm_msgHiveSignOperations switch). */
function opScreens(op: Op): { screens: OledScreen[]; active: boolean; contact?: boolean } | null {
  const [type, v] = op
  const s: OledScreen[] = []
  const add = (x: OledScreen[] | null) => { if (!x) throw new Error('unformattable'); s.push(...x) }
  const c = (title: string, body: string) => add(confirmScreens(title, body))
  const slice = (title: string, text: unknown) => add(hiveSliceScreens(title, utf8(text)))
  const asset = (t: unknown) => { const a = hiveAsset(t); if (!a) throw new Error('asset'); return a }
  try {
    switch (type) {
      case 'vote': {
        const w = Number(v.weight)
        c(w < 0 ? 'Downvote' : 'Vote', `@${v.voter} -> @${v.author} at ${pct(Math.abs(w))}`)
        slice('Vote Target', v.permlink)
        return { screens: s, active: false }
      }
      case 'comment': {
        const top = !v.parent_author
        c(top ? 'Post' : 'Comment', top ? `Create post by @${v.author}?` : `Reply by @${v.author} to @${v.parent_author}?`)
        slice(top ? 'Post Category' : 'Reply Target', v.parent_permlink)
        slice('Post Permlink', v.permlink)
        if (String(v.title ?? '')) slice('Post Title', v.title)
        slice('Post Body', v.body)
        if (String(v.json_metadata ?? '')) slice('Post Metadata', v.json_metadata)
        return { screens: s, active: false }
      }
      case 'custom_json': {
        const active: string[] = (v.required_auths ?? []).slice().sort()
        const posting: string[] = (v.required_posting_auths ?? []).slice().sort()
        const auths = [...active, ...posting]
        const needsActive = active.length > 0
        auths.forEach((a, i) => c('Custom JSON Auth', `${i + 1}/${auths.length}: @${a}\n${needsActive ? 'Active' : 'Posting'} key`))
        slice('Custom JSON ID', v.id)
        slice('Custom JSON', typeof v.json === 'string' ? v.json : JSON.stringify(v.json))
        return { screens: s, active: needsActive }
      }
      case 'transfer_to_vesting': {
        const amt = asset(v.amount)
        c('Power Up', !v.to ? `Power up\n${amt}\nto @${v.from}` : `${amt}\nfrom @${v.from}\nto @${v.to}`)
        return { screens: s, active: true, contact: true }
      }
      case 'withdraw_vesting':
        c(assetIsZero(v.vesting_shares) ? 'Stop Power Down' : 'Power Down', assetIsZero(v.vesting_shares) ? `Cancel power down\nfor @${v.account}` : `Power down\n${asset(v.vesting_shares)}\nfrom @${v.account}`)
        return { screens: s, active: true }
      case 'limit_order_create': {
        c('Market Order', `@${v.owner} sells\n${asset(v.amount_to_sell)}\nfor >= ${asset(v.min_to_receive)}`)
        const exp = typeof v.expiration === 'number' ? v.expiration : Math.floor(Date.parse(`${String(v.expiration).replace(/Z?$/, 'Z')}`) / 1000)
        c('Order Terms', `Order #${Number(v.orderid) >>> 0}\n${v.fill_or_kill ? 'Fill or kill' : 'Rests on book'}\nExpires ${exp >>> 0}`)
        return { screens: s, active: true }
      }
      case 'limit_order_cancel':
        c('Cancel Order', `Cancel order #${Number(v.orderid) >>> 0}\nfor @${v.owner}?`)
        return { screens: s, active: true }
      case 'convert':
        c('Convert', `Convert ${asset(v.amount)}\nto HIVE for @${v.owner}\n(#${Number(v.requestid) >>> 0})`)
        return { screens: s, active: true }
      case 'transfer_to_savings':
      case 'transfer_from_savings':
        c(type === 'transfer_to_savings' ? 'Savings Deposit' : 'Savings Withdraw', `${asset(v.amount)}\nfrom @${v.from}\nto @${v.to}`)
        if (String(v.memo ?? '')) slice('Savings Memo', v.memo)
        return { screens: s, active: true, contact: true }
      case 'comment_options': {
        c('Payout Options', `@${v.author}\nMax ${asset(v.max_accepted_payout)}\nHBD split ${pct(Number(v.percent_hbd))}`)
        c('Payout Options', `Votes: ${v.allow_votes ? 'allowed' : 'disabled'}\nCuration: ${v.allow_curation_rewards ? 'allowed' : 'disabled'}`)
        const ext = Array.isArray(v.extensions) ? v.extensions.find((e: any) => Array.isArray(e) && Number(e[0]) === 0) : undefined
        const benef: Array<{ account: string; weight: number }> = ext?.[1]?.beneficiaries ?? []
        benef.forEach((b, i) => c('Payout Beneficiary', `${i + 1}/${benef.length}: @${b.account}\ngets ${pct(Number(b.weight))}`))
        slice('Payout Permlink', v.permlink)
        return { screens: s, active: false }
      }
      case 'claim_reward_balance':
        c('Claim Rewards', `@${v.account} claims\n${asset(v.reward_hive)}\n${asset(v.reward_hbd)}`)
        c('Claim Rewards', `@${v.account} claims\n${asset(v.reward_vests)}`)
        return { screens: s, active: false }
      case 'delegate_vesting_shares':
        c(assetIsZero(v.vesting_shares) ? 'Remove Delegation' : 'Delegate', assetIsZero(v.vesting_shares)
          ? `@${v.delegator} removes its\ndelegation to @${v.delegatee}?`
          : `@${v.delegator} delegates\n${asset(v.vesting_shares)}\nto @${v.delegatee}`)
        return { screens: s, active: true, contact: !assetIsZero(v.vesting_shares) }
      case 'account_update2': {
        c('Profile Update', `Update profile\nof @${v.account}?`)
        if (String(v.json_metadata ?? '')) slice('Account Metadata', v.json_metadata)
        if (String(v.posting_json_metadata ?? '')) slice('Profile Metadata', v.posting_json_metadata)
        return { screens: s, active: !!String(v.json_metadata ?? '') }
      }
      default:
        return null
    }
  } catch { return null }
}

const HIVE_MAINNET_CHAIN = 'beeab0de' + '0'.repeat(56)

/** hive_confirm_chain(): one screen, only for a non-mainnet chain id. */
function chainScreens(chainId: unknown): OledScreen[] {
  if (typeof chainId !== 'string' || !chainId || chainId.toLowerCase() === HIVE_MAINNET_CHAIN) return []
  return confirmBytesScreens('Custom Hive chain', utf8(chainId.toLowerCase())) ?? []
}

/** HiveSignOperations: every op's screens, then the final sign prompt. */
export function hiveSignOperationsMirror(body: { operations?: unknown; chain_id?: unknown }): DeviceMirror | null {
  if (!Array.isArray(body.operations) || !body.operations.length) return null
  const screens: OledScreen[] = [...chainScreens(body.chain_id)]
  const mainnet = !screens.length
  let active = false
  const contactBefore: number[] = []
  for (const op of body.operations as Op[]) {
    if (!Array.isArray(op) || typeof op[0] !== 'string' || !op[1] || typeof op[1] !== 'object') return null
    const r = opScreens(op)
    if (!r) return { exact: false, screens, reason: `Desktop cannot reproduce the KeepKey screens for "${op[0]}".` }
    // contact_book_confirm_address runs before the op's first screen (mainnet only).
    if (r.contact && mainnet) contactBefore.push(screens.length)
    screens.push(...r.screens)
    active ||= r.active
  }
  const n = body.operations.length
  const last = confirmScreens('Sign Transaction', `Sign ${n} Hive operation${n === 1 ? '' : 's'} with the ${active ? 'active' : 'posting'} key?`)
  if (!last) return null
  screens.push(...last)
  return { exact: true, screens, ...(contactBefore.length ? { mayPrepend: 'certified-contact' as const, contactBefore } : {}) }
}

/** The mirror for a Hive signing request, or null for anything else. */
export function hiveDeviceMirror(method: string, body: unknown): DeviceMirror | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (method === '/hive/sign-message') return hiveSignMessageMirror(b)
  if (method === '/hive/sign-transfer') return hiveSignTransferMirror(b)
  if (method === '/hive/sign-operations') return hiveSignOperationsMirror(b)
  return null
}

/** Where the device is after `buttonRequests` ButtonRequests: screens
 *  from..to (0-based). One screen when every ButtonRequest is predictable; a
 *  range when certified-contact screens may or may not have been shown (each
 *  is shown as the screen it precedes). `beyond` when the device asked for
 *  more confirmations than this mirror has screens. */
export interface MirrorPosition { from: number; to: number; beyond?: boolean }
export function mirrorPosition(mirror: DeviceMirror, buttonRequests: number): MirrorPosition {
  const total = mirror.screens.length
  if (!total || buttonRequests <= 0) return { from: 0, to: 0 }
  // The device's possible sequence: optional contact screens, then each screen.
  const items: { optional: boolean; shows: number }[] = []
  for (let i = 0; i < total; i++) {
    for (const at of mirror.contactBefore ?? []) if (at === i) items.push({ optional: true, shows: i })
    items.push({ optional: false, shows: i })
  }
  let states = new Set([-1])
  for (let step = 0; step < buttonRequests && states.size; step++) {
    const next = new Set<number>()
    for (const p of states) {
      for (let q = p + 1; q < items.length; q++) {
        next.add(q)
        if (!items[q]!.optional) break // a screen that always shows cannot be skipped
      }
    }
    states = next
  }
  if (!states.size) return { from: total - 1, to: total - 1, beyond: true }
  const shown = [...states].map(q => items[q]!.shows)
  return { from: Math.min(...shown), to: Math.max(...shown) }
}

/** The screen to show for the device's position (the latest it can be on). */
export function mirrorStep(mirror: DeviceMirror, buttonRequests: number): number {
  return mirrorPosition(mirror, buttonRequests).to
}

/** Plain text of a Hive message for the review fields (UTF-8, or null for hex). */
export function hiveMessageText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b.message !== 'string') return null
  if (b.is_text !== false) return b.message
  const hex = b.message.replace(/^0x/, '')
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(hex.match(/../g)!.map(h => parseInt(h, 16)))) }
  catch { return null }
}
