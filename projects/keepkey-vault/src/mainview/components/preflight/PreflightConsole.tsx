/**
 * Preflight console — shared building blocks for decision dialogs (firmware
 * flash, signing approval). One surface, no nested cards: structure comes from
 * type, alignment and hairlines. Risks are a checklist with one status mark
 * per row; a blocking row disables the main action, and the action says why.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { CHAINS } from '../../../shared/chains'
import { AssetIcon } from '../AssetIcon'

const CSS = `
.kk-pf { position: relative; display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
  border-radius: 18px; overflow: hidden; color: var(--text-0); font-family: var(--font-ui-sans);
  background:
    radial-gradient(120% 80% at 0% 0%, rgba(233,196,106,.10), transparent 55%),
    radial-gradient(90% 70% at 100% 100%, rgba(98,126,234,.07), transparent 60%),
    var(--ink-0);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.06), 0 30px 80px -30px rgba(0,0,0,.8); }
.kk-pf.kk-pf-sg { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
/* Embedded in a surface that already is the console (setup wizard): no second background, frame or shadow. */
.kk-pf.kk-pf-flat { background: transparent; box-shadow: none; border-radius: 0; overflow: visible; }
.kk-pf.kk-pf-flat .kk-pf-left { padding-left: 0; padding-top: 8px; }
.kk-pf.kk-pf-flat .kk-pf-right { padding-right: 0; padding-top: 8px; }
@media (max-width: 760px) { .kk-pf, .kk-pf.kk-pf-sg { grid-template-columns: minmax(0, 1fr); } }
.kk-pf-left { padding: 26px 26px 22px; display: flex; flex-direction: column; gap: 18px; min-height: 0; }
.kk-pf-right { padding: 26px 26px 22px 22px; position: relative; display: flex; flex-direction: column; gap: 20px; min-height: 0; }
.kk-pf-right::before { content: ""; position: absolute; left: 0; top: 26px; bottom: 26px; width: 1px;
  background: linear-gradient(transparent, rgba(255,255,255,.09) 15%, rgba(255,255,255,.09) 85%, transparent); }
@media (max-width: 760px) { .kk-pf-right::before { left: 26px; right: 26px; top: 0; bottom: auto; width: auto; height: 1px; } }
.kk-pf-scroll { overflow-y: auto; min-height: 0; }
.kk-pf-kicker { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .32em; text-transform: uppercase; color: var(--gold); }
.kk-pf-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.kk-pf-vers { display: flex; align-items: baseline; gap: 14px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; line-height: 1; }
.kk-pf-from { font-size: 22px; color: var(--text-3); text-decoration: line-through; text-decoration-color: rgba(255,255,255,.18); }
.kk-pf-to { font-size: clamp(34px, 4.6vw, 46px); font-weight: 600; letter-spacing: -.02em;
  background: linear-gradient(180deg, var(--gold-2), #c9aa5c); -webkit-background-clip: text; background-clip: text; color: transparent; }
.kk-pf-beam { position: relative; flex: 1; min-width: 40px; height: 1px; align-self: center;
  background: linear-gradient(90deg, rgba(255,255,255,.08), rgba(233,196,106,.7)); }
.kk-pf-beam i { position: absolute; top: -2px; width: 5px; height: 5px; border-radius: 50%; background: var(--gold-2);
  box-shadow: 0 0 10px var(--gold); animation: kk-pf-pkt 2.4s linear infinite; }
.kk-pf-beam i:nth-child(2) { animation-delay: .8s; } .kk-pf-beam i:nth-child(3) { animation-delay: 1.6s; }
@keyframes kk-pf-pkt { from { left: 0; opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } to { left: calc(100% - 5px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .kk-pf-beam i { animation: none; left: 50%; } }
.kk-pf-file { font-family: var(--font-mono); font-size: 11px; color: var(--text-2); word-break: break-word; margin-top: -8px; }
.kk-pf-dim { color: var(--text-3); }
.kk-pf-device { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.kk-pf-cap { font-size: 12px; color: var(--text-2); max-width: 20ch; line-height: 1.35; }
.kk-pf-list { list-style: none; margin: 0; padding: 0; display: grid; }
.kk-pf-list > li { display: grid; grid-template-columns: 14px minmax(0,1fr) auto; gap: 12px; align-items: baseline; padding: 10px 0; border-top: 1px solid rgba(255,255,255,.06); }
.kk-pf-list > li:first-child { border-top: 0; }
.kk-pf-list b { display: block; font-size: 13.5px; font-weight: 600; line-height: 1.35; }
.kk-pf-detail { font-size: 12.5px; color: var(--text-1); line-height: 1.5; margin-top: 2px; }
.kk-pf-detail p { margin: 4px 0 0; }
.kk-pf-tag { font-style: normal; font-family: var(--font-mono); font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--rose); }
.kk-pf-dot { width: 8px; height: 8px; border-radius: 50%; transform: translateY(-1px); display: inline-block; }
.kk-pf-block .kk-pf-dot { background: var(--rose); box-shadow: 0 0 0 4px rgba(224,140,123,.16); } .kk-pf-block b { color: var(--rose); }
.kk-pf-danger .kk-pf-dot { box-shadow: inset 0 0 0 2px var(--rose); }
.kk-pf-warn .kk-pf-dot { box-shadow: inset 0 0 0 2px var(--gold); }
.kk-pf-ok .kk-pf-dot { background: var(--teal); } .kk-pf-ok b { color: var(--text-1); font-weight: 500; }
.kk-pf-check { display: flex; align-items: flex-start; gap: 8px; margin-top: 8px; cursor: pointer; user-select: none; font-size: 12px; font-weight: 600; color: var(--text-0); }
.kk-pf-check input { margin-top: 2px; accent-color: var(--gold); width: 14px; height: 14px; flex: none; }
.kk-pf-danger .kk-pf-check input { accent-color: var(--rose); }
.kk-pf-actions { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: center; margin-top: auto; }
.kk-pf-actions button { font-family: var(--font-mono); font-size: 12.5px; border: 0; cursor: pointer; border-radius: 999px; padding: 12px 18px; white-space: nowrap; }
/* Wrapping row: buttons never break their label; when they don't fit side by side they stack, primary first. */
.kk-pf-actions.kk-pf-wrap { display: flex; flex-wrap: wrap; gap: 10px; }
.kk-pf-actions.kk-pf-wrap > button { flex: 1 1 auto; }
.kk-pf-cancel { background: transparent; color: var(--text-1); }
.kk-pf-outline { background: transparent; color: var(--gold); box-shadow: inset 0 0 0 1px rgba(233,196,106,.55); font-weight: 600; }
.kk-pf-outline:hover { background: rgba(233,196,106,.08); }
.kk-pf-outline:disabled, .kk-pf-cancel:disabled { opacity: .45; cursor: not-allowed; }
.kk-pf-kv { display: grid; font-size: 12px; }
.kk-pf-kv > div { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 4px 12px; align-items: center; padding: 8px 0; border-top: 1px solid rgba(255,255,255,.06); }
.kk-pf-kv > div:first-child { border-top: 0; }
.kk-pf-kv dt { color: var(--text-2); grid-column: 1 / -1; }
.kk-pf-kv dd { margin: 0; font-family: var(--font-mono); color: var(--text-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kk-pf-copy { background: none; border: 0; padding: 2px 0; font-family: var(--font-mono); font-size: 11px; color: var(--gold); cursor: pointer; }
.kk-pf-pos { height: 46px; background: transparent; border: 0; border-right: 1px solid rgba(255,255,255,.1); border-bottom: 1px solid rgba(255,255,255,.1); cursor: pointer; display: grid; place-items: center; transition: background .1s; padding: 0; }
.kk-pf-pos span { width: 5px; height: 5px; border-radius: 50%; background: var(--text-2); }
.kk-pf-pos:hover { background: rgba(233,196,106,.08); } .kk-pf-pos:active { background: rgba(233,196,106,.22); }
.kk-pf-pos:disabled { opacity: .35; cursor: not-allowed; }
.kk-pf-pos:focus-visible { outline: 2px solid var(--gold); outline-offset: -2px; }
.kk-pf-link { background: none; border: 0; padding: 0; font-size: 12px; color: var(--gold); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; text-align: left; }
.kk-pf-h { font-size: 15px; font-weight: 600; color: var(--text-0); margin: 0; }
.kk-pf-title { font-size: clamp(24px, 3vw, 32px); font-weight: 600; letter-spacing: -.02em; line-height: 1.15; margin: 0; }
.kk-pf-sub { font-size: 14px; color: var(--text-1); margin: 4px 0 0; line-height: 1.5; }
.kk-pf-cancel:hover { color: var(--text-0); }
.kk-pf-go { background: linear-gradient(180deg, var(--gold-2), #c9aa5c); color: #17140a; font-weight: 600; letter-spacing: .02em; }
.kk-pf-go.kk-pf-go-danger { background: linear-gradient(180deg, #ef9f8f, var(--rose)); color: #1d0b07; }
.kk-pf-go:disabled { background: transparent; color: var(--gold); box-shadow: inset 0 0 0 1px rgba(233,196,106,.45); cursor: not-allowed; }
.kk-pf-actions button:focus-visible, .kk-pf-modes button:focus-visible, .kk-pf-tech summary:focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; }
.kk-pf-hint { text-align: center; font-family: var(--font-mono); font-size: 10px; color: var(--text-2); }
.kk-pf-tl { position: relative; display: grid; gap: 14px; padding-left: 4px; }
.kk-pf-tl::before { content: ""; position: absolute; left: 17px; top: 30px; bottom: 30px; width: 1px; background: linear-gradient(rgba(255,255,255,.14), rgba(255,255,255,.04)); }
.kk-pf-mark { display: flex; align-items: baseline; gap: 10px; font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .22em; text-transform: uppercase; color: var(--text-2); margin-top: 4px; }
.kk-pf-mark span { font-size: 18px; letter-spacing: -.01em; color: var(--text-0); text-transform: none; }
.kk-pf-item { position: relative; display: grid; grid-template-columns: 28px minmax(0,1fr); gap: 14px; align-items: start; }
.kk-pf-item b { font-size: 14px; font-weight: 600; display: block; }
.kk-pf-item b small { font-family: var(--font-mono); font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-2); margin-left: 6px; font-weight: 400; }
.kk-pf-item p { margin: 2px 0 0; font-size: 12.5px; color: var(--text-1); line-height: 1.45; }
.kk-pf-item.kk-pf-soon { opacity: .62; }
.kk-pf-node { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 13px; overflow: hidden;
  background: var(--c); color: #fff; box-shadow: 0 0 0 4px var(--ink-0), 0 0 22px -4px var(--c); position: relative; z-index: 1; flex: none; }
.kk-pf-node.kk-pf-chain { background: var(--ink-1); }
.kk-pf-node.kk-pf-glyph { background: var(--ink-3); color: var(--text-1); box-shadow: 0 0 0 4px var(--ink-0), inset 0 0 0 1px rgba(255,255,255,.14); }
.kk-pf-node.kk-pf-num { background: transparent; color: var(--text-1); font-family: var(--font-mono); font-size: 12px; font-weight: 500;
  box-shadow: 0 0 0 4px var(--ink-0), inset 0 0 0 1px rgba(255,255,255,.22); }
.kk-pf-node.kk-pf-num.kk-pf-gold { color: #17140a; background: linear-gradient(180deg, var(--gold-2), #c9aa5c); box-shadow: 0 0 0 4px var(--ink-0), 0 0 22px -4px var(--gold); }
.kk-pf-modes { display: flex; gap: 14px; align-items: center; }
.kk-pf-modes button { background: none; border: 0; padding: 2px 0; font-family: var(--font-mono); font-size: 11px; letter-spacing: .06em; color: var(--text-2); cursor: pointer; border-bottom: 1px solid transparent; }
.kk-pf-modes button[aria-selected="true"], .kk-pf-modes button[aria-pressed="true"] { color: var(--text-0); border-bottom-color: var(--gold); }
.kk-pf-who { display: flex; align-items: center; gap: 14px; }
.kk-pf-app { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-1); min-width: 0; }
.kk-pf-appic { width: 26px; height: 26px; border-radius: 8px; background: var(--ink-3); display: grid; place-items: center; font-family: var(--font-mono); font-size: 10px; color: var(--text-1); box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); flex: none; }
.kk-pf-acct { display: inline-flex; align-items: center; gap: 10px; font-size: clamp(20px, 2.6vw, 28px); font-weight: 600; letter-spacing: -.02em; min-width: 0; }
.kk-pf-acct > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kk-pf-lede { margin: 0; font-size: 14.5px; line-height: 1.55; color: var(--text-1); max-width: 46ch; }
.kk-pf-facts { display: grid; gap: 0; font-size: 12px; }
.kk-pf-facts > div { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-top: 1px solid rgba(255,255,255,.06); }
.kk-pf-facts > div:first-child { border-top: 0; }
.kk-pf-facts dt { color: var(--text-2); } .kk-pf-facts dd { margin: 0; font-family: var(--font-mono); color: var(--text-0); text-align: right; overflow-wrap: anywhere; }
.kk-pf-tech summary { cursor: pointer; font-family: var(--font-mono); font-size: 11px; letter-spacing: .06em; color: var(--text-2); }
.kk-pf-steps { list-style: decimal; padding-left: 18px; margin: 6px 0 0; }
/* As a dialog: never taller than the window. The row is clamped so the
   columns scroll inside it; a split column keeps its decision row pinned. */
.kk-pf:not(.kk-pf-flat) { max-height: calc(100vh - 32px); grid-template-rows: minmax(0, 1fr); }
.kk-pf-left.kk-pf-split { padding: 0; gap: 0; overflow: hidden; }
.kk-pf-split > .kk-pf-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 26px 26px 14px; display: flex; flex-direction: column; gap: 18px; }
.kk-pf-split > .kk-pf-foot { flex: none; display: grid; gap: 8px; padding: 12px 26px 22px; }
.kk-pf-foot > .kk-pf-actions { margin-top: 0; }
.kk-pf-body[data-more] + .kk-pf-foot { box-shadow: 0 -1px 0 rgba(255,255,255,.06); }
/* More below: the last lines fade out instead of being cut. */
.kk-pf-scroll[data-more] { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 40px), transparent);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 40px), transparent); }
.kk-pf-note { margin: 0; font-size: 11px; line-height: 1.5; color: var(--text-2); }
.kk-pf-fold > summary { list-style: none; display: flex; align-items: baseline; gap: 10px; }
.kk-pf-fold > summary::-webkit-details-marker { display: none; }
.kk-pf-fold > summary::after { content: "+"; font-family: var(--font-mono); color: var(--gold); }
.kk-pf-fold[open] > summary::after { content: "–"; }
.kk-pf-fold[open] > summary { margin-bottom: 12px; }
@media (max-width: 760px) {
  .kk-pf:not(.kk-pf-flat) { grid-template-rows: none; overflow-y: auto; }
  .kk-pf-left.kk-pf-split { overflow: visible; }
  .kk-pf-split > .kk-pf-body { overflow: visible; }
  .kk-pf-split > .kk-pf-foot { position: sticky; bottom: 0; z-index: 1; background: var(--ink-0); }
}
/* Inside a dialog panel that already draws the console's surface. */
.kk-pf.kk-pf-inset { background: transparent; box-shadow: none; border-radius: 0; max-height: none; flex: 1 1 auto; min-height: 0; }
/* A decision row across both columns (forms). */
.kk-pf.kk-pf-rows:not(.kk-pf-flat) { grid-template-rows: minmax(0, 1fr) auto; }
.kk-pf > .kk-pf-foot.kk-pf-span { grid-column: 1 / -1; display: grid; gap: 10px; padding: 12px 26px 20px; box-shadow: 0 -1px 0 rgba(255,255,255,.06); }
.kk-pf-right.kk-pf-split { padding: 0; gap: 0; overflow: hidden; }
/* Amounts: official logo, figure, then a quiet line under it. */
.kk-pf-amt { display: flex; align-items: center; gap: 14px; min-width: 0; }
.kk-pf-amt.kk-pf-ends { justify-content: space-between; }
.kk-pf-amt > div { display: grid; grid-template-columns: auto minmax(0, auto); column-gap: 10px; align-items: center; min-width: 0; }
.kk-pf-amt > div > :first-child:not(b) { grid-row: span 2; }
.kk-pf-amt b { font-family: var(--font-mono); font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.kk-pf-amt small { color: var(--text-2); font-size: 11.5px; }
.kk-pf-amt.kk-pf-ends > div { grid-template-columns: minmax(0, auto); }
.kk-pf-amt.kk-pf-ends > div:last-child { text-align: right; justify-items: end; }
/* A value typed on the surface: no box, one hairline. (Not .kk-pf-num: that is NumberNode.) */
.kk-pf-field { width: 100%; min-width: 0; background: transparent; border: 0; border-bottom: 1px solid rgba(255,255,255,.14); border-radius: 0; color: var(--text-0);
  font-family: var(--font-mono); font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; padding: 4px 0 6px; outline: none; }
.kk-pf-field:focus { border-bottom-color: var(--gold); }
.kk-pf-field[aria-invalid="true"] { border-bottom-color: var(--rose); }
.kk-pf-field.kk-pf-sm { font-size: 12px; font-weight: 500; padding: 6px 0; }
.kk-pf-field:disabled { opacity: .6; }
/* A chosen item that opens a picker: logo, name, quiet sub-line. */
.kk-pf-pick { display: flex; align-items: center; gap: 12px; background: none; border: 0; padding: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; min-width: 0; }
.kk-pf-pick:disabled { cursor: default; opacity: .7; }
.kk-pf-pick b { font-size: 22px; font-weight: 600; letter-spacing: -.01em; }
.kk-pf-pick .kk-pf-dim { font-size: 15px; }
.kk-pf-pick small { display: block; font-size: 11.5px; color: var(--text-2); margin-top: 2px; }
.kk-pf-pick:focus-visible { outline: 2px solid var(--gold); outline-offset: 4px; border-radius: 6px; }
/* Busy state of a pill. */
.kk-pf-spin { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid currentColor; border-right-color: transparent; display: inline-block; vertical-align: -1px; margin-right: 8px; animation: kk-pf-rot .8s linear infinite; }
@keyframes kk-pf-rot { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .kk-pf-spin { animation-duration: 2.4s; } }
/* Round icon button sitting on the column divider. */
.kk-pf-pivot { position: absolute; left: 50%; z-index: 2; width: 38px; height: 38px; margin-left: -19px; border-radius: 50%; border: 0; cursor: pointer; display: grid; place-items: center;
  background: var(--ink-0); color: var(--gold); box-shadow: inset 0 0 0 1px rgba(233,196,106,.45), 0 0 0 5px var(--ink-0); transition: transform .3s; }
.kk-pf-pivot:hover:not(:disabled) { transform: rotate(180deg); }
.kk-pf-pivot:disabled { opacity: .4; cursor: default; }
.kk-pf-pivot:focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; }
@media (max-width: 760px) { .kk-pf-pivot { display: none; } }
/* Columns split by a pivot: each side keeps the same clear space from it
   (19px half-button + 25px air), and the pivot sits on the logos' centre line. */
.kk-pf.kk-pf-pivoted > .kk-pf-left { padding-right: 44px; }
.kk-pf.kk-pf-pivoted > .kk-pf-right { padding-left: 44px; }
.kk-pf.kk-pf-pivoted > .kk-pf-pivot { top: 57px; }
@media (max-height: 820px) { .kk-pf.kk-pf-pivoted > .kk-pf-pivot { top: 49px; } }
/* Short windows (the vault opens at 1200×800): tighter rhythm, smaller print. */
@media (max-height: 820px) {
  .kk-pf-left:not(.kk-pf-split) { padding: 18px 22px 16px; gap: 12px; }
  .kk-pf-split > .kk-pf-body { padding: 18px 22px 10px; gap: 12px; }
  .kk-pf-split > .kk-pf-foot { padding: 10px 22px 16px; gap: 6px; }
  .kk-pf-right { padding: 18px 22px 16px 20px; gap: 14px; }
  .kk-pf-right::before { top: 18px; bottom: 18px; }
  .kk-pf-lede { font-size: 13.5px; line-height: 1.5; }
  .kk-pf-list > li { padding: 7px 0; }
  .kk-pf-acct { font-size: clamp(18px, 2.2vw, 24px); }
  .kk-pf-tl { gap: 10px; }
  .kk-pf-actions button { padding: 10px 16px; }
  .kk-pf-hint { font-size: 9.5px; }
  .kk-pf-note { font-size: 10px; }
  .kk-pf > .kk-pf-foot.kk-pf-span { padding: 10px 22px 14px; gap: 8px; }
  .kk-pf-amt b { font-size: 18px; }
  .kk-pf-field { font-size: 22px; }
}
`

/** The height below which the console compacts (matches the CSS above). */
export const PREFLIGHT_SHORT_QUERY = '(max-height: 820px)'

/** True while the window is short enough for the compact console. */
export function usePreflightShort() {
	const query = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PREFLIGHT_SHORT_QUERY) : null
	const [short, setShort] = useState(() => !!query()?.matches)
	useEffect(() => {
		const mq = query()
		if (!mq) return
		const on = () => setShort(mq.matches)
		on()
		mq.addEventListener?.('change', on)
		return () => mq.removeEventListener?.('change', on)
	}, [])
	return short
}

/** Ref for a .kk-pf-scroll area: marks it data-more while content is hidden
 *  below, so the CSS fades its last lines instead of cutting them. */
export function usePreflightScroll<T extends HTMLElement = HTMLElement>() {
	const [el, setEl] = useState<T | null>(null)
	useEffect(() => {
		if (!el) return
		const update = () => {
			const more = el.scrollHeight - el.scrollTop - el.clientHeight > 2
			if (more) el.setAttribute('data-more', '')
			else el.removeAttribute('data-more')
		}
		update()
		el.addEventListener('scroll', update, { passive: true })
		const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
		resize?.observe(el)
		const mutate = typeof MutationObserver === 'function' ? new MutationObserver(update) : null
		mutate?.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['open'] })
		return () => { el.removeEventListener('scroll', update); resize?.disconnect(); mutate?.disconnect() }
	}, [el])
	return setEl
}

/** Injects the console stylesheet once per render tree. */
export function PreflightStyles() {
	return <style>{CSS}</style>
}

export function Beam() {
	return <span className="kk-pf-beam" aria-hidden="true"><i /><i /><i /></span>
}

export type PreflightStatus = 'block' | 'danger' | 'warn' | 'ok'
export interface PreflightRow {
	key: string
	status: PreflightStatus
	title: ReactNode
	detail?: ReactNode
	/** Right-aligned mono tag, e.g. "blocks". */
	tag?: ReactNode
	/** Extra data-* attributes for the row (test and automation hooks). */
	attrs?: Record<string, string>
}
const ORDER: Record<PreflightStatus, number> = { block: 0, danger: 1, warn: 2, ok: 3 }

/** Checklist, most severe first; each row carries exactly one status mark. */
export function PreflightList({ rows, label }: { rows: PreflightRow[]; label?: string }) {
	const sorted = rows.slice().sort((a, b) => ORDER[a.status] - ORDER[b.status])
	return (
		<ol className="kk-pf-list" aria-label={label}>
			{sorted.map(r => (
				<li key={r.key} className={`kk-pf-${r.status}`} data-preflight={r.status} {...r.attrs}>
					<span className="kk-pf-dot" />
					<div><b>{r.title}</b>{r.detail && <div className="kk-pf-detail">{r.detail}</div>}</div>
					{r.tag ? <em className="kk-pf-tag">{r.tag}</em> : <span />}
				</li>
			))}
		</ol>
	)
}

/** Acknowledgement checkbox that lives inside a preflight row. */
export function PreflightCheck({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
	return (
		<label className="kk-pf-check">
			<input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
			<span>{children}</span>
		</label>
	)
}

export function PreflightActions({ cancelLabel, onCancel, goLabel, onGo, goDisabled, danger }: {
	cancelLabel: ReactNode; onCancel: () => void; goLabel: ReactNode; onGo: () => void; goDisabled?: boolean; danger?: boolean
}) {
	return (
		<div className="kk-pf-actions">
			<button type="button" className="kk-pf-cancel" onClick={onCancel}>{cancelLabel}</button>
			<button type="button" className={`kk-pf-go${danger ? ' kk-pf-go-danger' : ''}`} onClick={onGo} disabled={goDisabled} aria-disabled={goDisabled}>{goLabel}</button>
		</div>
	)
}

export type FeatureGlyph = 'feature' | 'security' | 'performance' | 'network'
const GLYPH_PATHS: Record<FeatureGlyph, ReactNode> = {
	// Four-point spark: a capability, not a network.
	feature: <path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z" />,
	security: <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />,
	performance: <path d="M13 3L5 13h6l-1 8 8-10h-6z" />,
	// Unknown network: a plain ring.
	network: <path fillRule="evenodd" d="M12 3a9 9 0 110 18 9 9 0 010-18zm0 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11z" />,
}

/** Timeline / account node. A network always shows its official coloured
 *  logo through AssetIcon — the same component, sources and fallbacks as the
 *  chain page — on a neutral disc, with a glow in the network's colour (a
 *  logo drawn on a disc of its own colour, e.g. Hive's red mark, vanished).
 *  Anything that is not a network gets one neutral glyph, never a loose letter. */
export function ChainNode({ chainId, color, glyph = 'feature' }: { chainId?: string; color?: string; glyph?: FeatureGlyph }) {
	const chain = chainId ? CHAINS.find(c => c.id === chainId) : undefined
	if (chain) {
		return (
			<span className="kk-pf-node kk-pf-chain" style={{ ['--c' as string]: color || chain.color }} title={chain.coin}>
				<AssetIcon caip={chain.caip} alt={chain.symbol} size={28} />
			</span>
		)
	}
	return (
		<span className="kk-pf-node kk-pf-glyph" aria-hidden="true">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">{GLYPH_PATHS[glyph]}</svg>
		</span>
	)
}

export function TimelineMark({ big, small }: { big: ReactNode; small?: ReactNode }) {
	return <div className="kk-pf-mark"><span>{big}</span>{small}</div>
}

export function TimelineItem({ node, title, soonLabel, children }: { node: ReactNode; title: ReactNode; soonLabel?: ReactNode; children?: ReactNode }) {
	return (
		<div className={`kk-pf-item${soonLabel ? ' kk-pf-soon' : ''}`}>
			{node}
			<div><b>{title}{soonLabel && <small>{soonLabel}</small>}</b>{children && <p>{children}</p>}</div>
		</div>
	)
}

export function NumberNode({ n, gold }: { n: number; gold?: boolean }) {
	return <span className={`kk-pf-node kk-pf-num${gold ? ' kk-pf-gold' : ''}`}>{n}</span>
}
