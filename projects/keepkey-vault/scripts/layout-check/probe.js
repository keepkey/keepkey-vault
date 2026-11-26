(() => {
  const w = window
  if (!w.__ready) return JSON.stringify({ notReady: true })
  const W = innerWidth, H = innerHeight
  const dlg = document.querySelector('.kk-sd-panel') || document.querySelector('.kk-ap') || document.querySelector('[data-magi-swap] .kk-pf') || document.querySelector('[data-swap-panel]')
  if (!dlg) return JSON.stringify({ noDialog: true })
  const R = e => e.getBoundingClientRect()
  const box = r => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })
  const r = R(dlg)
  const out = { W, H, dialog: box(r) }
  out.centeredX = Math.abs(r.left - (W - r.right)) <= 1.5
  out.centeredY = Math.abs(r.top - (H - r.bottom)) <= 1.5
  out.inViewport = r.left >= 0 && r.top >= 0 && r.right <= W + 0.5 && r.bottom <= H + 0.5
  const in3d = e => !!e.closest('.kk-sd-stage, [data-oled-screen]')
  const inClosedDetails = e => { const d = e.closest('details'); return !!d && !d.open && !e.closest('summary') }
  const visible = e => { if (inClosedDetails(e)) return false; const s = getComputedStyle(e); const b = R(e); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0 && b.width > 0 && b.height > 0 }
  // The clipping rect an element is actually seen through (every overflow ancestor up to the viewport).
  const clipOf = e => { let c = { l: 0, t: 0, r: W, b: H }; for (let a = e.parentElement; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== 'visible' || s.overflowY !== 'visible') { const ar = R(a); c = { l: Math.max(c.l, ar.left), t: Math.max(c.t, ar.top), r: Math.min(c.r, ar.right), b: Math.min(c.b, ar.bottom) } } } return c }
  const seen = (rect, c) => rect.right > c.l + 1 && rect.left < c.r - 1 && rect.bottom > c.t + 1 && rect.top < c.b - 1
  // Primary actions: visible, inside the viewport, and the topmost thing at their centre.
  const actions = [...dlg.querySelectorAll('.kk-pf-go, .kk-pf-actions button, .kk-ap-foot .kk-pf-go')].filter(visible)
  out.actions = actions.map(a => { const b = R(a); const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2); return { text: (a.textContent || '').trim().slice(0, 40), box: box(b), reachable: !!hit && (hit === a || a.contains(hit)) } })
  out.actionVisible = out.actions.length === 0 ? 'n/a (no primary action: rows are the action)' : out.actions.every(a => a.reachable)
  // Items for overlap / clipping: text line boxes, images, buttons.
  const items = []
  const walker = document.createTreeWalker(dlg, NodeFilter.SHOW_TEXT)
  for (let n; (n = walker.nextNode());) {
    if (!n.textContent.trim() || !n.parentElement || !visible(n.parentElement) || in3d(n.parentElement)) continue
    if (n.parentElement.closest('style,script,svg text')) continue
    const range = document.createRange(); range.selectNodeContents(n)
    for (const rect of range.getClientRects()) if (rect.width > 1 && rect.height > 1) items.push({ kind: 'text', el: n.parentElement, node: n, rect, label: n.textContent.trim().slice(0, 30) })
  }
  for (const img of dlg.querySelectorAll('img')) if (visible(img) && !in3d(img)) items.push({ kind: 'img', el: img, rect: R(img), label: img.alt || (img.getAttribute('src') || '').slice(-24) })
  for (const b of dlg.querySelectorAll('button')) if (visible(b)) items.push({ kind: 'button', el: b, rect: R(b), label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30) })
  const cutTo = (r, c) => ({ left: Math.max(r.left, c.l), right: Math.min(r.right, c.r), top: Math.max(r.top, c.t), bottom: Math.min(r.bottom, c.b) })
  const vis = items.filter(i => seen(i.rect, clipOf(i.el))).map(i => ({ ...i, rect: cutTo(i.rect, clipOf(i.el)) }))
  const related = (a, b) => a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)
  const sameIcon = (a, b) => { // an AssetIcon's network badge over its own logo
    if (a.kind !== 'img' || b.kind !== 'img') return false
    let x = a.el; for (let i = 0; i < 4 && x; i++) { x = x.parentElement; if (x && x.contains(b.el)) return true } return false }
  const overlaps = []
  for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
    const a = vis[i], b = vis[j]
    if (related(a, b) || sameIcon(a, b)) continue
    if (a.kind === 'button' && b.kind === 'button') { if (a.el.contains(b.el) || b.el.contains(a.el)) continue }
    const ix = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left)
    const iy = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top)
    if (ix > 1.5 && iy > 1.5) overlaps.push(`${a.kind}:${a.label} × ${b.kind}:${b.label} (${Math.round(ix)}x${Math.round(iy)})`)
  }
  out.overlaps = overlaps.slice(0, 12); out.overlapCount = overlaps.length
  // Cut: text crossing a clipping ancestor sideways (not scrolled, not an intended ellipsis),
  // or clipped vertically by a container that does not scroll.
  const cut = []
  for (const t of items.filter(i => i.kind === 'text')) {
    for (let a = t.el; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a)
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
      if (getComputedStyle(t.el).textOverflow === 'ellipsis' || s.textOverflow === 'ellipsis') break
      const ar = R(a)
      const sideways = t.rect.right > ar.right + 1 || t.rect.left < ar.left - 1
      const scrollsY = (s.overflowY === 'auto' || s.overflowY === 'scroll')
      const down = !scrollsY && (t.rect.bottom > ar.bottom + 1 || t.rect.top < ar.top - 1)
      if (sideways || down) cut.push(`${t.label} in ${a.className || a.tagName}`)
      break
    }
  }
  out.cut = cut.slice(0, 10); out.cutCount = cut.length
  // Logos on a disc: the image's wrapper paints a background or a border.
  const discs = []
  for (const img of dlg.querySelectorAll('img')) {
    if (!visible(img) || img.closest('[data-trade-route-map] foreignObject[width="128"]')) continue // the route's art is round on purpose
    const p = img.parentElement, s = getComputedStyle(p)
    const bg = s.backgroundColor, painted = bg && bg !== 'transparent' && !/rgba\(0, 0, 0, 0\)/.test(bg)
    const bordered = ['Top','Right','Bottom','Left'].every(k => parseFloat(s['border' + k + 'Width']) > 0 && s['border' + k + 'Style'] !== 'none')
    const big = R(img).width >= 20 // network badges are small on purpose (they sit on a ring)
    if (big && (painted || bordered)) discs.push(img.alt || (img.getAttribute('src') || '').slice(-30))
  }
  out.discs = discs
  // Boxes (old visual): an element bordered on all four sides, other than inputs and the dialog.
  const boxed = []
  for (const e of dlg.querySelectorAll('*')) {
    if (!visible(e) || e === dlg || in3d(e) || (R(e).width < 24 && R(e).height < 24) || e.matches('input,select,textarea,img,svg,svg *,label.kk-pf-check input')) continue
    const s = getComputedStyle(e)
    const all = ['Top', 'Right', 'Bottom', 'Left'].every(k => parseFloat(s['border' + k + 'Width']) > 0 && s['border' + k + 'Style'] !== 'none' && !/rgba\(0, 0, 0, 0\)/.test(s['border' + k + 'Color']))
    if (all) boxed.push((e.className && typeof e.className === 'string' ? e.className.split(' ')[0] : e.tagName) + ':' + (e.textContent || '').trim().slice(0, 20))
  }
  out.boxed = boxed.slice(0, 10); out.boxedCount = boxed.length
  // The pivot between the two asset logos: centred on the divider and on their centre line, equal air both sides.
  const pivot = dlg.querySelector('.kk-pf-pivot')
  if (pivot && visible(pivot)) {
    const pr = R(pivot)
    const leftCol = dlg.querySelector('[data-swap-form] > .kk-pf-left'), rightCol = dlg.querySelector('[data-swap-form] > .kk-pf-right')
    const logo = col => col && col.querySelector('[data-swap-asset] .kk-pf-pick img, [data-swap-asset] .kk-pf-pick > span')
    const rl = logo(rightCol), ll = logo(leftCol)
    const rr = rl && R(rl), lr = ll && R(ll)
    const divider = R(rightCol).left
    out.pivot = { box: box(pr), divider: Math.round(divider), centreOnDivider: Math.abs((pr.left + pr.right) / 2 - divider) <= 1.5,
      gapToRightLogo: rr ? Math.round(rr.left - pr.right) : null,
      leftColumnAir: Math.round(R(leftCol).right - parseFloat(getComputedStyle(leftCol).paddingRight) - R(leftCol).right + (R(leftCol).right - pr.left)),
      rightPad: parseFloat(getComputedStyle(rightCol).paddingLeft), leftPad: parseFloat(getComputedStyle(leftCol).paddingRight),
      dyToLogos: rr ? Math.round((pr.top + pr.bottom) / 2 - (rr.top + rr.bottom) / 2) : null }
    out.pivot.symmetric = out.pivot.rightPad === out.pivot.leftPad
    out.pivot.clear = out.pivot.gapToRightLogo !== null && out.pivot.gapToRightLogo >= 12
  }
  const oledRows = [...dlg.querySelectorAll('[data-oled-screen] *')].filter(e => e.children.length === 0 && (e.textContent || '').trim())
  out.oled = oledRows.length ? { rows: oledRows.length, overflowing: oledRows.filter(e => e.scrollWidth > (e.parentElement.clientWidth || e.clientWidth) + 1).map(e => e.textContent.trim().slice(0, 30)) } : null
  // Empty area per column: how much of its inner height its content blocks
  // cover (vertical union). A column that scrolls is full; an intended empty
  // state is reported as such. Over 45% empty fails.
  const columns = [...dlg.querySelectorAll(':scope > .kk-pf-left, :scope > .kk-pf-right, :scope .kk-pf > .kk-pf-left, :scope .kk-pf > .kk-pf-right, .kk-ap-body, .kk-sd-body')].filter(visible)
  out.columns = columns.map(c => {
    const cs = getComputedStyle(c), cr = R(c)
    const top = cr.top + parseFloat(cs.paddingTop), bottom = cr.bottom - parseFloat(cs.paddingBottom)
    const inner = Math.max(1, bottom - top)
    const name = (c.className || '').toString().split(' ').filter(x => /kk-(pf-(left|right)|ap-body|sd-body)/.test(x)).join('') + (c.closest('[data-swap-form]') ? '@form' : c.closest('[data-swap-review]') ? '@review' : c.closest('[data-swap-signing]') ? '@signing' : c.closest('[data-magi-swap]') ? '@magi' : '')
    const scroller = c.matches('.kk-pf-split') ? c.querySelector(':scope > .kk-pf-body') : c
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 2) return { name, empty: 0, note: 'scrolls' }
    const blocks = c.matches('.kk-pf-split') ? [...c.querySelectorAll(':scope > .kk-pf-body > *, :scope > .kk-pf-foot')] : [...c.querySelectorAll(':scope > *')]
    const shown = blocks.filter(b => !b.matches('style,script') && visible(b))
    if (shown.length && shown.every(b => b.matches('.kk-ap-empty'))) return { name, empty: null, note: 'empty-state' }
    const spans = shown.map(b => { const r = R(b); return [Math.max(top, r.top), Math.min(bottom, r.bottom)] }).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
    let covered = 0, end = -Infinity
    for (const [a, b] of spans) { if (a > end) { covered += b - a; end = b } else if (b > end) { covered += b - end; end = b } }
    return { name, empty: Math.round((1 - covered / inner) * 100) / 100 }
  })
  out.emptyFail = out.columns.filter(c => c.empty !== null && c.empty > 0.45).map(c => `${c.name} ${Math.round(c.empty * 100)}%`)
  // Timeline / step nodes are round (border-radius at least half their width).
  const nodes = [...dlg.querySelectorAll('.kk-pf-node')].filter(visible)
  out.squareNodes = nodes.filter(n => { const s = getComputedStyle(n); const r = s.borderRadius.endsWith('%') ? parseFloat(s.borderRadius) / 100 * R(n).width : parseFloat(s.borderRadius); return r < R(n).width / 2 - 1 }).map(n => (n.textContent || '').trim())
  out.flicker = { rowRemovals: w.__rowRemovals ?? null, loadingSeen: w.__loadingSeen ?? null, imgLoads: w.__imgLoads ?? null }
  return JSON.stringify(out)
})()
