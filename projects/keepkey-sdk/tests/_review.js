/**
 * Review tape: what a suite made KeepKey Desktop and the device SHOW.
 *
 * A signature coming back proves the request signed. It does not prove the
 * user was shown the right thing. While a suite runs, Desktop records
 *   - each approval card's risk assessment (the coloured bar and its reasons)
 *   - each raw device frame held at a confirmation, which is read back to
 *     text here with the firmware's own font tables (fixtures/oled-font.json)
 * and run-all.js compares that tape with the reviewed copy in tests/review/.
 *
 * Needs the emulator and KEEPKEY_TEST_EMULATOR_CONTROL=1 on Desktop; see
 * tests/README.md.
 */
const fs = require('fs')
const path = require('path')

const BASE = process.env.KEEPKEY_URL || 'http://localhost:1646'
const W = 256, H = 64

// ── Device screen → text ─────────────────────────────────────────────

const FONTS = Object.entries(require('./fixtures/oled-font.json').fonts).map(([name, glyphs]) => ({
  name,
  space: glyphs[' '].w,
  // Widest first, so a glyph that is the left part of another loses to it.
  glyphs: Object.entries(glyphs).filter(([ch]) => ch !== ' ')
    .map(([ch, g]) => ({ ch, w: g.w, h: g.h, rows: g.rows.map((r) => [...r].map((c) => c === '#')), ink: g.rows.join('').split('#').length - 1 }))
    .sort((a, b) => b.w - a.w),
}))
const GLYPH_H = 10
// Further apart than this and two runs on one row are separate columns.
const MAX_SPACES = 4

/** base64 SSD1306 buffer (8 pages x 256 columns, bit 0 on top) → lit[y][x]. */
function frameBits(frame) {
  const fb = Buffer.from(frame, 'base64')
  const lit = []
  for (let y = 0; y < H; y++) {
    const row = new Uint8Array(W)
    for (let x = 0; x < W; x++) row[x] = (fb[(y >> 3) * W + x] >> (y & 7)) & 1
    lit.push(row)
  }
  return lit
}

function glyphAt(lit, g, x, y) {
  if (x + g.w > W) return false
  for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) if (!!lit[y + r][x + c] !== g.rows[r][c]) return false
  return true
}

function blank(lit, x, y, w) {
  if (x + w > W) return false
  for (let r = 0; r < GLYPH_H; r++) for (let c = 0; c < w; c++) if (lit[y + r][x + c]) return false
  return true
}

/** Longest exact run of one font's glyphs starting at (x, y). */
function runAt(lit, font, x, y, memo) {
  if (memo.has(x)) return memo.get(x)
  let best = { text: '', end: x, ink: 0 }
  for (const g of font.glyphs) {
    if (!glyphAt(lit, g, x, y)) continue
    let rest = runAt(lit, font, x + g.w, y, memo)
    // Nothing follows directly: allow word gaps, then more glyphs.
    for (let s = 1; !rest.ink && s <= MAX_SPACES && blank(lit, x + g.w, y, s * font.space); s++) {
      const after = runAt(lit, font, x + g.w + s * font.space, y, memo)
      if (after.ink) rest = { text: ' '.repeat(s) + after.text, end: after.end, ink: after.ink }
    }
    const cand = { text: g.ch + rest.text, end: rest.ink ? rest.end : x + g.w, ink: g.ink + rest.ink }
    if (cand.ink > best.ink) best = cand
  }
  memo.set(x, best)
  return best
}

/**
 * The text on one device frame, top to bottom. Exact: every character is a
 * pixel-for-pixel match of a firmware glyph. Icons and progress bars are not
 * text and are left out.
 */
function readScreen(frame) {
  const lit = frameBits(frame)
  const runs = []
  for (const font of FONTS) {
    for (let y = 0; y + GLYPH_H <= H; y++) {
      const memo = new Map()
      for (let x = 0; x < W; x++) {
        const run = runAt(lit, font, x, y, memo)
        // One stray glyph-shaped speck is not text.
        if (run.ink >= 6 && run.text.replace(/ /g, '').length >= 2) runs.push({ ...run, x, y })
      }
    }
  }
  // Keep the heaviest runs; drop anything overlapping one already kept.
  runs.sort((a, b) => b.ink - a.ink)
  const kept = []
  for (const r of runs) {
    if (!kept.some((k) => r.x < k.end && k.x < r.end && Math.abs(r.y - k.y) < GLYPH_H)) kept.push(r)
  }
  kept.sort((a, b) => a.y - b.y || a.x - b.x)
  const lines = []
  for (const r of kept) {
    const last = lines[lines.length - 1]
    if (last && last.y === r.y) last.text += `   ${r.text}`
    else lines.push({ y: r.y, text: r.text })
  }
  return lines.map((l) => l.text)
}

// ── Tape ─────────────────────────────────────────────────────────────

/** Fetch what Desktop recorded, empty its tape, and set whether it keeps recording. */
async function takeTape(record) {
  const post = () => fetch(`${BASE}/emulator/test-tape`, {
    method: 'POST',
    // No keep-alive: a suite can run for minutes, and Desktop has closed an idle socket by then.
    headers: { Authorization: `Bearer ${require('./_helpers').savedApiKey()}`, 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ record }),
  })
  const res = await post().catch(post)
  if (!res.ok) throw new Error(`review tape unavailable (HTTP ${res.status}): start Desktop on the emulator with KEEPKEY_TEST_EMULATOR_CONTROL=1`)
  return (await res.json()).entries.map((e) => (e.kind === 'screen'
    ? { screen: e.operation, lines: readScreen(e.frame) }
    : { card: e.method, level: e.risk ? e.risk.level : 'none', reasons: e.risk ? e.risk.reasons.map((r) => `${r.level}: ${r.text}`) : [], blind: e.needsBlindSigning,
        // What the Desktop window rendered; absent when the card was approved without being shown.
        // The countdown in the card header changes every second; leave it out.
        ...(e.text ? { window: e.text.filter((l) => !/^\d+:\d\d$/.test(l)) } : {}) }))
}

// ── Reviewed copies ──────────────────────────────────────────────────

const REVIEW_DIR = path.join(__dirname, 'review')
const SUITES = JSON.parse(fs.readFileSync(path.join(REVIEW_DIR, 'suites.json'), 'utf8'))
const reviewedPath = (suite) => path.join(REVIEW_DIR, 'shown', `${suite.replace(/\//g, '__').replace(/\.js$/, '')}.json`)

/** Why a real-world suite's tape is not a healthy one, or [] when it is. */
function unhealthy(tape) {
  const problems = []
  for (const e of tape) {
    if (e.card && e.level !== 'low' && e.level !== 'none') problems.push(`approval card for ${e.card} reads "${e.level}": ${e.reasons.join(' | ')}`)
    if (e.card && e.blind) problems.push(`approval card for ${e.card} asks for blind signing`)
    if (e.card && !e.window) problems.push(`approval card for ${e.card} was not shown in the Desktop window`)
    const loud = (e.window || []).filter((l) => /Danger|High risk|Check before you sign|blind|Advanced Mode/i.test(l))
    if (loud.length) problems.push(`Desktop window for ${e.card} says: ${loud.join(' | ')}`)
    if (e.screen && e.lines.some((l) => /BLOCKED|AdvancedMode|blind|Unknown/i.test(l))) problems.push(`device screen during ${e.screen}: ${e.lines.join(' / ')}`)
    if (e.screen && e.lines.length === 0) problems.push(`device screen during ${e.screen} had no readable text`)
  }
  return problems
}

/**
 * Judge one suite's tape. Real-world suites must be healthy and must match
 * their reviewed copy exactly. KEEPKEY_REVIEW=record rewrites the copy
 * instead (then read the diff before committing it).
 */
function judge(suite, tape, passed) {
  const cls = (SUITES[suite] || {}).class
  const file = reviewedPath(suite)
  if (process.env.KEEPKEY_REVIEW === 'record') {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(tape, null, 2) + '\n')
  }
  if (!cls) return { verdict: 'UNCLASSIFIED', problems: [`add ${suite} to tests/review/suites.json`] }
  if (cls === 'edge-case' || cls === 'no-signing') return { verdict: cls, problems: [] }
  // A risky request must not look healthy; a normal one must.
  const problems = cls === 'must-warn' ? (unhealthy(tape).length ? [] : ['a risky request showed no warning']) : unhealthy(tape)
  // A suite that skips itself, or signs without Desktop asking, proves nothing.
  if (!passed) problems.push('the suite itself failed')
  if (!tape.some((e) => e.card)) problems.push('no Desktop approval card was shown')
  if (!fs.existsSync(file)) problems.push('no reviewed copy; run with KEEPKEY_REVIEW=record and review it')
  else {
    const want = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')))
    if (want !== JSON.stringify(tape)) problems.push(`shown content differs from ${path.relative(path.join(__dirname, '..'), file)}`)
  }
  return { verdict: problems.length ? 'UNHEALTHY' : cls === 'must-warn' ? 'warned' : 'healthy', problems }
}

module.exports = { readScreen, takeTape, judge, unhealthy, SUITES }
