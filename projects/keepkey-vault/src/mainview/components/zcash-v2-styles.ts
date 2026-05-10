// Zcash UI styles, scoped under `.zcash-v2`. Originally based on the Claude Design
// handoff at design/Zcash Orchard v2.html, but trimmed down for a beginner-friendly,
// utilitarian feel: smaller headings, no editorial italic, fewer power-user knobs.
export const ZCASH_V2_CSS = `
.zcash-v2 {
	--zk-bg: #0b0b0c;
	--zk-bg-1: #121214;
	--zk-bg-2: #18181b;
	--zk-bg-3: #1f1f23;
	--zk-line: #26262a;
	--zk-line-soft: #1c1c20;
	--zk-fg: #f3f1ec;
	--zk-fg-dim: #b8b4ac;
	--zk-fg-mute: #74706a;
	--zk-fg-faint: #4a4742;
	--zk-gold: #c9a368;
	--zk-gold-hi: #e0bb7e;
	--zk-gold-deep: #8c6c3d;
	--zk-gold-soft: rgba(201, 163, 104, 0.14);
	--zk-gold-line: rgba(201, 163, 104, 0.28);
	--zk-green: #6ee787;
	--zk-green-soft: rgba(110, 231, 135, 0.12);
	--zk-copper: #d97757;
	--zk-copper-soft: rgba(217, 119, 87, 0.12);
	--zk-font-display: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
	--zk-font-mono: "JetBrains Mono", ui-monospace, Menlo, monospace;

	color: var(--zk-fg);
	font-family: var(--zk-font-display);
	letter-spacing: -0.005em;
	-webkit-font-smoothing: antialiased;
	padding: 4px 4px 24px;
}
.zcash-v2 *, .zcash-v2 *::before, .zcash-v2 *::after { box-sizing: border-box; }
.zcash-v2 button { font-family: inherit; color: inherit; background: none; border: none; cursor: pointer; padding: 0; }
.zcash-v2 button:disabled { opacity: 0.45; cursor: not-allowed; }
.zcash-v2 input { font-family: inherit; color: inherit; background: none; border: none; outline: none; }

/* ---- balance card (replaces editorial balance strip) ---- */
.zcash-v2 .zk-balance {
	display: flex; align-items: center; gap: 16px;
	padding: 18px 20px;
	border: 1px solid var(--zk-line);
	border-radius: 10px;
	background: var(--zk-bg-1);
	margin-bottom: 16px;
}
.zcash-v2 .bal-glyph {
	width: 40px; height: 40px; border-radius: 9px;
	background: linear-gradient(180deg, var(--zk-gold), var(--zk-gold-deep));
	display: grid; place-items: center;
	color: #1a1408; flex-shrink: 0;
}
.zcash-v2 .zk-balance .main { flex: 1; min-width: 0; }
.zcash-v2 .zk-balance .lbl {
	font-family: var(--zk-font-mono); font-size: 10.5px;
	letter-spacing: 0.14em; text-transform: uppercase;
	color: var(--zk-fg-mute);
}
.zcash-v2 .zk-balance .amount {
	margin-top: 4px;
	font-family: var(--zk-font-mono); font-weight: 500;
	font-size: 26px; letter-spacing: -0.02em;
	font-variant-numeric: tabular-nums;
}
.zcash-v2 .zk-balance .amount .ticker { color: var(--zk-gold); font-size: 13px; margin-left: 8px; }
.zcash-v2 .zk-balance .amount .pending { color: var(--zk-fg-mute); font-size: 11px; margin-left: 12px; }
.zcash-v2 .zk-balance .sub {
	margin-top: 4px;
	font-family: var(--zk-font-mono); font-size: 11px;
	color: var(--zk-fg-mute);
}
.zcash-v2 .zk-balance .status-pill {
	display: inline-flex; align-items: center; gap: 6px;
	font-family: var(--zk-font-mono); font-size: 10.5px;
	color: var(--zk-fg-dim);
	padding: 5px 10px; border: 1px solid var(--zk-line);
	border-radius: 999px; background: var(--zk-bg);
	flex-shrink: 0;
}
.zcash-v2 .zk-balance .status-pill .led {
	width: 6px; height: 6px; border-radius: 50%;
	background: var(--zk-green);
	box-shadow: 0 0 0 3px var(--zk-green-soft);
}
.zcash-v2 .zk-balance .status-pill .led.amber {
	background: var(--zk-gold);
	box-shadow: 0 0 0 3px var(--zk-gold-soft);
}
.zcash-v2 .zk-balance .syncing {
	margin-top: 8px;
	display: flex; align-items: center; gap: 10px;
	font-family: var(--zk-font-mono); font-size: 10.5px;
	color: var(--zk-fg-mute);
}
.zcash-v2 .zk-balance .syncing .pb {
	flex: 1; height: 4px; background: var(--zk-bg-3);
	border-radius: 999px; overflow: hidden;
}
.zcash-v2 .zk-balance .syncing .pb-fill {
	height: 100%; background: linear-gradient(90deg, var(--zk-gold-deep), var(--zk-gold));
	transition: width 0.2s ease-out;
}

/* ---- page nav ---- */
.zcash-v2 .page-nav {
	display: flex; gap: 2px;
	border-bottom: 1px solid var(--zk-line);
	margin-bottom: 20px;
	padding: 0;
	overflow-x: auto;
	scrollbar-width: none;
}
.zcash-v2 .page-nav::-webkit-scrollbar { display: none; }
.zcash-v2 .page-nav button {
	padding: 10px 14px;
	font-family: var(--zk-font-display); font-size: 13px;
	font-weight: 500;
	color: var(--zk-fg-mute);
	border-bottom: 2px solid transparent;
	margin-bottom: -1px;
	flex-shrink: 0;
	transition: color 120ms, background 120ms;
	white-space: nowrap;
	display: inline-flex; align-items: center; gap: 8px;
}
.zcash-v2 .page-nav button .ico {
	display: inline-flex; align-items: center;
	opacity: 0.55;
	transition: opacity 120ms, transform 120ms;
}
.zcash-v2 .page-nav button:hover { color: var(--zk-fg-dim); }
.zcash-v2 .page-nav button:hover .ico { opacity: 0.95; }
.zcash-v2 .page-nav button[data-active="1"] { color: var(--zk-fg); border-bottom-color: currentColor; }
.zcash-v2 .page-nav button[data-active="1"] .ico { opacity: 1; }
/* Active tab adopts the icon's accent color for the underline + label hint. */
.zcash-v2 .page-nav button[data-active="1"]:nth-child(1) { color: #c9a368; border-bottom-color: #c9a368; }
.zcash-v2 .page-nav button[data-active="1"]:nth-child(2) { color: #d97757; border-bottom-color: #d97757; }
.zcash-v2 .page-nav button[data-active="1"]:nth-child(3) { color: #6ee787; border-bottom-color: #6ee787; }
.zcash-v2 .page-nav button[data-active="1"]:nth-child(4) { color: #7aa6f0; border-bottom-color: #7aa6f0; }
.zcash-v2 .page-nav button[data-active="1"]:nth-child(5) { color: #b794f4; border-bottom-color: #b794f4; }
.zcash-v2 .page-nav button[data-active="1"]:nth-child(6) { color: #56d4d4; border-bottom-color: #56d4d4; }

/* ---- verify-on-device card (Receive page) ---- */
.zcash-v2 .verify-card {
	margin-top: 16px;
	padding: 20px 22px;
	border: 1px solid var(--zk-gold-line);
	background: linear-gradient(180deg, rgba(201,163,104,0.06), transparent);
	border-radius: 10px;
}
.zcash-v2 .verify-head { display: flex; gap: 14px; margin-bottom: 16px; }
.zcash-v2 .verify-ico {
	width: 36px; height: 36px; flex-shrink: 0;
	border-radius: 9px;
	background: linear-gradient(180deg, var(--zk-gold), var(--zk-gold-deep));
	color: #1a1408;
	display: grid; place-items: center;
}
.zcash-v2 .verify-ico svg { width: 18px; height: 18px; }
.zcash-v2 .verify-title {
	font-family: var(--zk-font-display); font-size: 14px; font-weight: 600;
	color: var(--zk-fg); margin-bottom: 4px;
}
.zcash-v2 .verify-sub {
	font-family: var(--zk-font-display); font-size: 12.5px;
	color: var(--zk-fg-dim); line-height: 1.55;
}
.zcash-v2 .verify-btn { font-size: 15px; padding: 16px 24px; }
.zcash-v2 .verify-btn-ico { display: inline-flex; align-items: center; }
.zcash-v2 .verify-btn-ico svg { width: 16px; height: 16px; }
.zcash-v2 .verify-card .verify-note {
	margin-top: 10px;
	padding: 10px 14px;
	border-radius: 6px;
	background: var(--zk-bg);
	border: 1px solid var(--zk-line);
	font-family: var(--zk-font-display); font-size: 12px;
	color: var(--zk-fg-mute); line-height: 1.5;
	display: block; text-transform: none; letter-spacing: 0;
}
.zcash-v2 .verify-card .verify-note strong { color: var(--zk-gold); }

/* ---- card primitives ---- */
.zcash-v2 .card {
	border: 1px solid var(--zk-line);
	border-radius: 10px;
	background: var(--zk-bg-1);
	overflow: hidden;
	position: relative;
	min-width: 0;
}
.zcash-v2 .card-head {
	display: flex; align-items: center; justify-content: space-between;
	padding: 14px 18px;
	border-bottom: 1px solid var(--zk-line-soft);
	gap: 12px;
}
.zcash-v2 .card-head .title {
	display: flex; align-items: center; gap: 10px;
	font-family: var(--zk-font-display); font-size: 13px;
	font-weight: 500;
	color: var(--zk-fg);
}
.zcash-v2 .card-head .meta {
	font-family: var(--zk-font-mono); font-size: 10.5px;
	color: var(--zk-fg-mute); letter-spacing: 0.04em;
}
.zcash-v2 .card-body { padding: 18px; }

/* ---- page header ---- */
.zcash-v2 .page-head {
	margin-bottom: 16px;
}
.zcash-v2 .page-head h2 {
	margin: 0;
	font-family: var(--zk-font-display);
	font-size: 18px; font-weight: 600;
	letter-spacing: -0.015em;
}
.zcash-v2 .page-head p {
	margin: 6px 0 0;
	color: var(--zk-fg-mute); font-size: 12.5px;
	max-width: 60ch; line-height: 1.5;
}

/* ---- form fields ---- */
.zcash-v2 .field {
	border: 1px solid var(--zk-line);
	border-radius: 6px;
	background: var(--zk-bg);
	padding: 10px 12px;
	display: flex; align-items: center; gap: 10px;
	transition: border-color 120ms;
}
.zcash-v2 .field:focus-within { border-color: var(--zk-gold-line); }
.zcash-v2 .field .lbl {
	font-family: var(--zk-font-display); font-size: 11.5px;
	color: var(--zk-fg-mute); flex-shrink: 0; width: 80px;
	font-weight: 500;
}
.zcash-v2 .field input { flex: 1; min-width: 0; font-family: var(--zk-font-mono); font-size: 13px; color: var(--zk-fg); }
.zcash-v2 .field input::placeholder { color: var(--zk-fg-faint); }
.zcash-v2 .field .suffix { font-family: var(--zk-font-mono); font-size: 11px; color: var(--zk-fg-mute); flex-shrink: 0; }
.zcash-v2 .field .max {
	font-family: var(--zk-font-display); font-size: 11px;
	color: var(--zk-gold); letter-spacing: 0.04em; text-transform: uppercase;
	padding: 3px 8px;
	border: 1px solid var(--zk-gold-line); border-radius: 3px;
	background: var(--zk-gold-soft);
	flex-shrink: 0; font-weight: 600;
}
.zcash-v2 .field .max:hover:not(:disabled) { background: rgba(201,163,104,0.22); }
.zcash-v2 .field-err {
	font-family: var(--zk-font-display); font-size: 12px;
	color: var(--zk-copper); padding: 0 2px;
}
.zcash-v2 .field-hint {
	font-family: var(--zk-font-display); font-size: 11.5px;
	color: var(--zk-fg-mute); padding: 0 2px;
	display: inline-flex; align-items: center; gap: 6px;
}
.zcash-v2 .field-hint::before {
	content: ""; width: 4px; height: 4px; border-radius: 50%;
	background: var(--zk-green);
}
.zcash-v2 .balance-row {
	display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
	padding: 10px 12px;
	margin-bottom: 12px;
	border: 1px solid var(--zk-line);
	border-radius: 6px;
	background: var(--zk-bg);
	font-family: var(--zk-font-display); font-size: 12px;
	color: var(--zk-fg-mute);
}
.zcash-v2 .balance-row strong {
	font-family: var(--zk-font-mono); font-weight: 500;
	font-size: 13.5px; color: var(--zk-gold);
	font-variant-numeric: tabular-nums;
}
.zcash-v2 .balance-row .balance-hint {
	color: var(--zk-fg-faint); font-size: 11px;
	margin-left: auto;
}
.zcash-v2 .balance-row .ghost-btn { padding: 3px 8px; font-size: 12px; margin-left: auto; }
.zcash-v2 .row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.zcash-v2 .field-grid { display: grid; gap: 12px; }

/* ---- buttons ---- */
.zcash-v2 .submit {
	display: inline-flex; align-items: center; justify-content: center; gap: 8px;
	padding: 12px 22px;
	background: var(--zk-gold); color: #1a1408;
	font-family: var(--zk-font-display); font-weight: 600;
	font-size: 13.5px; border-radius: 6px;
	transition: transform 120ms, background 120ms;
}
.zcash-v2 .submit:hover:not(:disabled) { background: var(--zk-gold-hi); }
.zcash-v2 .submit.alt {
	background: transparent; color: var(--zk-fg);
	box-shadow: 0 0 0 1px var(--zk-line) inset;
}
.zcash-v2 .submit.alt:hover:not(:disabled) { background: var(--zk-bg-2); box-shadow: 0 0 0 1px var(--zk-fg-faint) inset; }
.zcash-v2 .submit.warn {
	background: var(--zk-copper); color: #2a1308;
}
.zcash-v2 .submit.warn:hover:not(:disabled) { background: #ea8a6e; }
.zcash-v2 .submit.lg { padding: 14px 24px; font-size: 14px; width: 100%; }

.zcash-v2 .ghost-btn {
	display: inline-flex; align-items: center; gap: 6px;
	padding: 7px 11px;
	border: 1px solid var(--zk-line); border-radius: 4px;
	font-family: var(--zk-font-display); font-size: 12px;
	color: var(--zk-fg-dim);
}
.zcash-v2 .ghost-btn:hover:not(:disabled) { border-color: var(--zk-fg-faint); color: var(--zk-fg); background: var(--zk-bg-2); }

.zcash-v2 .submit-row {
	margin-top: 18px;
	display: flex; gap: 10px; align-items: center; justify-content: flex-end;
}
.zcash-v2 .submit-hint {
	flex: 1;
	font-family: var(--zk-font-display); font-size: 11.5px;
	color: var(--zk-fg-mute);
	display: flex; align-items: center; gap: 8px;
}
.zcash-v2 .submit-hint .kk-glyph {
	width: 18px; height: 18px;
	border-radius: 4px;
	background: var(--zk-fg); color: var(--zk-bg);
	display: grid; place-items: center;
	font-weight: 600; font-size: 9px;
	letter-spacing: -0.04em; flex-shrink: 0;
}

/* ---- tx flow status (in-form takeover during signing) ---- */
.zcash-v2 .tx-flow {
	margin-top: 12px;
	border: 1px solid var(--zk-line);
	border-radius: 10px;
	background: var(--zk-bg);
	overflow: hidden;
}
.zcash-v2 .tx-flow-gold     { border-color: var(--zk-gold-line); background: linear-gradient(180deg, rgba(201,163,104,0.06), transparent); }
.zcash-v2 .tx-flow-copper   { border-color: rgba(217,119,87,0.3); background: linear-gradient(180deg, rgba(217,119,87,0.05), transparent); }
.zcash-v2 .tx-flow-blue     { border-color: rgba(122,166,240,0.35); background: linear-gradient(180deg, rgba(122,166,240,0.05), transparent); }

.zcash-v2 .tx-flow-stepper {
	display: grid; grid-template-columns: repeat(3, 1fr);
	padding: 14px 18px;
	gap: 10px;
	border-bottom: 1px solid var(--zk-line-soft);
	position: relative;
}
.zcash-v2 .tx-flow-step {
	display: flex; align-items: center; gap: 10px;
	font-family: var(--zk-font-display); font-size: 12px;
	color: var(--zk-fg-faint);
	min-width: 0;
}
.zcash-v2 .tx-flow-step.done   { color: var(--zk-fg-mute); }
.zcash-v2 .tx-flow-step.active { color: var(--zk-fg); font-weight: 600; }
.zcash-v2 .tx-flow-dot {
	width: 22px; height: 22px; flex-shrink: 0;
	border-radius: 50%;
	border: 1.5px solid currentColor;
	display: grid; place-items: center;
	font-family: var(--zk-font-mono); font-size: 11px; font-weight: 600;
}
.zcash-v2 .tx-flow-step.done .tx-flow-dot {
	color: var(--zk-green); border-color: var(--zk-green);
	background: var(--zk-green-soft);
}
.zcash-v2 .tx-flow-step.active .tx-flow-dot {
	border-style: dashed;
}
.zcash-v2 .tx-flow-gold   .tx-flow-step.active .tx-flow-dot { color: var(--zk-gold);   background: var(--zk-gold-soft); }
.zcash-v2 .tx-flow-copper .tx-flow-step.active .tx-flow-dot { color: var(--zk-copper); background: var(--zk-copper-soft); }
.zcash-v2 .tx-flow-blue   .tx-flow-step.active .tx-flow-dot { color: #7aa6f0;          background: rgba(122,166,240,0.12); }
.zcash-v2 .tx-flow-spin {
	width: 10px; height: 10px;
	border-radius: 50%;
	border: 1.5px solid currentColor;
	border-top-color: transparent;
	animation: zk-spin 0.9s linear infinite;
}
@keyframes zk-spin { to { transform: rotate(360deg); } }
.zcash-v2 .tx-flow-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.zcash-v2 .tx-flow-body {
	padding: 18px 22px;
	display: flex; flex-direction: column; align-items: center;
	text-align: center;
}
.zcash-v2 .tx-flow-headline {
	font-family: var(--zk-font-display); font-size: 16px; font-weight: 600;
	color: var(--zk-fg); margin-bottom: 6px;
}
.zcash-v2 .tx-flow-body p {
	margin: 0; font-size: 12.5px; color: var(--zk-fg-dim);
	line-height: 1.55; max-width: 56ch;
}
.zcash-v2 .tx-flow-body p strong { color: var(--zk-fg); }

/* "Look at your KeepKey" — the loudest variant */
.zcash-v2 .tx-flow-signing { padding: 26px 22px 24px; }
.zcash-v2 .tx-flow-signing .tx-flow-headline {
	font-size: 22px; margin-bottom: 8px;
	color: var(--zk-gold);
	letter-spacing: -0.015em;
}
.zcash-v2 .tx-flow-copper .tx-flow-signing .tx-flow-headline { color: var(--zk-copper); }
.zcash-v2 .tx-flow-blue   .tx-flow-signing .tx-flow-headline { color: #7aa6f0; }
.zcash-v2 .tx-flow-device {
	color: var(--zk-gold);
	margin-bottom: 14px;
	animation: zk-pulse 1.6s ease-in-out infinite;
}
.zcash-v2 .tx-flow-copper .tx-flow-device { color: var(--zk-copper); }
.zcash-v2 .tx-flow-blue   .tx-flow-device { color: #7aa6f0; }
@keyframes zk-pulse {
	0%, 100% { opacity: 0.7; transform: translateY(0); }
	50%      { opacity: 1; transform: translateY(-2px); }
}

/* ---- result box ---- */
.zcash-v2 .result-box {
	margin-top: 14px;
	padding: 12px 14px;
	border-radius: 7px;
	border: 1px solid var(--zk-line);
}
.zcash-v2 .result-box.ok {
	background: var(--zk-green-soft);
	border-color: rgba(110,231,135,0.3);
}
.zcash-v2 .result-box.err {
	background: var(--zk-copper-soft);
	border-color: rgba(217,119,87,0.3);
}
.zcash-v2 .result-title {
	font-family: var(--zk-font-display); font-size: 12.5px;
	font-weight: 600;
	margin-bottom: 6px;
}
.zcash-v2 .result-box.ok .result-title { color: var(--zk-green); }
.zcash-v2 .result-box.err .result-title { color: var(--zk-copper); }
.zcash-v2 .result-txid {
	display: flex; flex-direction: column; gap: 8px;
	font-family: var(--zk-font-mono); font-size: 11.5px;
	color: var(--zk-fg-dim); line-height: 1.5;
}
.zcash-v2 .result-txid .txid-hash {
	display: block;
	word-break: break-all;
	padding: 8px 10px;
	border-radius: 4px;
	background: rgba(255,255,255,0.03);
	border: 1px solid var(--zk-line-soft);
	user-select: all;
}
.zcash-v2 .result-txid .txid-actions {
	display: flex; gap: 6px; flex-wrap: wrap;
}
.zcash-v2 .result-txid button {
	display: inline-flex; align-items: center; gap: 4px;
	color: var(--zk-gold);
	font-family: var(--zk-font-display); font-size: 12px; font-weight: 500;
	padding: 5px 10px; border-radius: 4px;
	border: 1px solid var(--zk-gold-line); background: var(--zk-gold-soft);
	cursor: pointer;
}
.zcash-v2 .result-txid button:hover { background: rgba(201,163,104,0.22); }
.zcash-v2 .result-txid button.txid-copy {
	color: var(--zk-fg-dim);
	border-color: var(--zk-line); background: var(--zk-bg);
}
.zcash-v2 .result-txid button.txid-copy:hover {
	color: var(--zk-fg); background: var(--zk-bg-2); border-color: var(--zk-fg-faint);
}
.zcash-v2 .result-msg { color: var(--zk-fg-dim); font-size: 12.5px; line-height: 1.5; }

/* ---- OVERVIEW ---- */
.zcash-v2 .quick-actions {
	display: grid; grid-template-columns: repeat(3, 1fr);
	gap: 10px; margin-bottom: 16px;
}
.zcash-v2 .quick-action {
	border: 1px solid var(--zk-line);
	border-radius: 8px;
	background: var(--zk-bg-1);
	padding: 16px 18px;
	text-align: left;
	transition: border-color 120ms, background 120ms;
}
.zcash-v2 .quick-action:hover {
	border-color: var(--zk-gold-line);
	background: rgba(201, 163, 104, 0.04);
}
.zcash-v2 .quick-action .qa-title {
	font-family: var(--zk-font-display); font-size: 14px;
	font-weight: 600; color: var(--zk-fg);
}
.zcash-v2 .quick-action .qa-sub {
	margin-top: 4px;
	font-family: var(--zk-font-display); font-size: 11.5px;
	color: var(--zk-fg-mute); line-height: 1.4;
}

.zcash-v2 .recent-list { display: flex; flex-direction: column; }
.zcash-v2 .recent-empty { padding: 24px; text-align: center; color: var(--zk-fg-mute); font-size: 12.5px; }
.zcash-v2 .recent-row {
	display: grid;
	grid-template-columns: auto 1fr auto;
	gap: 14px;
	padding: 12px 18px;
	align-items: center;
	border-top: 1px solid var(--zk-line-soft);
	font-size: 13px;
}
.zcash-v2 .recent-row:first-of-type { border-top: none; }
.zcash-v2 .recent-row .pill {
	font-family: var(--zk-font-mono); font-size: 9.5px;
	letter-spacing: 0.1em; text-transform: uppercase;
	padding: 2px 6px; border-radius: 2px;
}
.zcash-v2 .pill-orchard { background: var(--zk-gold-soft); color: var(--zk-gold); border: 1px solid var(--zk-gold-line); }
.zcash-v2 .pill-trans { background: rgba(255,255,255,0.04); color: var(--zk-fg-dim); border: 1px solid var(--zk-line); }
.zcash-v2 .recent-row .label { color: var(--zk-fg-dim); font-size: 12.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zcash-v2 .recent-row .label .memo { color: var(--zk-fg-mute); font-size: 11px; font-family: var(--zk-font-mono); display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; }
.zcash-v2 .recent-row .v { font-family: var(--zk-font-mono); font-size: 13px; font-variant-numeric: tabular-nums; text-align: right; flex-shrink: 0; }
.zcash-v2 .amount-pos { color: var(--zk-green); }
.zcash-v2 .amount-neg { color: var(--zk-fg); }

/* ---- form pages ---- */
.zcash-v2 .form-page {
	display: grid;
	grid-template-columns: 1fr;
	gap: 16px;
}
.zcash-v2 .form-page.with-aside {
	/* minmax(0,...) lets each column actually shrink to its share. Without it,
	   the implicit auto minimum keeps a column at min-content width and
	   pushes input suffixes / Max button / char counters out of view. */
	grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
	align-items: start;
}
.zcash-v2 .form-aside { display: grid; gap: 12px; align-content: start; min-width: 0; }
.zcash-v2 .aside-card {
	border: 1px solid var(--zk-line);
	border-radius: 10px;
	background: var(--zk-bg-1);
	padding: 14px 16px;
}
.zcash-v2 .aside-card h5 {
	margin: 0 0 8px;
	font-family: var(--zk-font-display); font-size: 11.5px;
	color: var(--zk-fg-mute); font-weight: 600;
}
.zcash-v2 .aside-card .kv {
	display: grid;
	grid-template-columns: 1fr auto;
	gap: 12px; align-items: baseline;
	padding: 6px 0;
	border-top: 1px dashed var(--zk-line-soft);
	font-size: 12px; color: var(--zk-fg-dim);
}
.zcash-v2 .aside-card .kv:first-of-type { border-top: none; padding-top: 0; }
.zcash-v2 .aside-card .kv .v { font-family: var(--zk-font-mono); color: var(--zk-fg); font-variant-numeric: tabular-nums; text-align: right; word-break: break-word; }
.zcash-v2 .aside-card .kv .v.gold { color: var(--zk-gold); }
.zcash-v2 .aside-card .kv .v.cp { color: var(--zk-copper); }
.zcash-v2 .aside-card .kv .v.gn { color: var(--zk-green); }
.zcash-v2 .aside-card p {
	margin: 0;
	font-size: 12px; color: var(--zk-fg-dim); line-height: 1.55;
}

/* ---- RECEIVE ---- */
.zcash-v2 .receive-grid {
	display: grid; grid-template-columns: 200px 1fr;
	gap: 22px; align-items: start;
}
.zcash-v2 .qr-wrap {
	aspect-ratio: 1/1;
	background: var(--zk-fg);
	border-radius: 8px;
	padding: 12px;
}
.zcash-v2 .qr-wrap > div { width: 100%; height: 100%; }
.zcash-v2 .qr-wrap svg { display: block; width: 100%; height: 100%; }
.zcash-v2 .addr-eyebrow {
	font-family: var(--zk-font-display); font-size: 11.5px;
	color: var(--zk-fg-mute); font-weight: 500; margin-bottom: 8px;
}
.zcash-v2 .addr-box {
	font-family: var(--zk-font-mono); font-size: 12.5px;
	color: var(--zk-fg-dim);
	background: var(--zk-bg);
	border: 1px solid var(--zk-line); border-radius: 6px;
	padding: 12px 14px;
	word-break: break-all; line-height: 1.55;
	margin-bottom: 10px;
}
.zcash-v2 .addr-actions { display: flex; gap: 6px; flex-wrap: wrap; }

/* ---- SCAN ---- */
.zcash-v2 .sync-status {
	display: flex; align-items: center; gap: 14px;
	padding: 18px 20px;
}
.zcash-v2 .sync-status .ico {
	width: 36px; height: 36px; border-radius: 50%;
	background: var(--zk-green-soft);
	color: var(--zk-green);
	display: grid; place-items: center;
	font-size: 18px; flex-shrink: 0;
}
.zcash-v2 .sync-status .ico.syncing {
	background: var(--zk-gold-soft); color: var(--zk-gold);
}
.zcash-v2 .sync-status .text { flex: 1; min-width: 0; }
.zcash-v2 .sync-status .text .title {
	font-family: var(--zk-font-display); font-size: 14px;
	font-weight: 600; color: var(--zk-fg);
}
.zcash-v2 .sync-status .text .sub {
	margin-top: 3px;
	font-family: var(--zk-font-mono); font-size: 11.5px;
	color: var(--zk-fg-mute);
}
.zcash-v2 .sync-progress {
	padding: 0 20px 18px;
}
.zcash-v2 .sync-progress .pb {
	height: 5px; border-radius: 999px;
	background: var(--zk-bg-3); overflow: hidden;
}
.zcash-v2 .sync-progress .pb-fill {
	height: 100%;
	background: linear-gradient(90deg, var(--zk-gold-deep), var(--zk-gold));
	transition: width 0.2s ease-out;
}
.zcash-v2 .sync-progress .meta {
	margin-top: 8px;
	display: flex; justify-content: space-between;
	font-family: var(--zk-font-mono); font-size: 11px;
	color: var(--zk-fg-mute);
}
.zcash-v2 .scan-cta {
	display: flex; gap: 10px; padding: 14px 20px;
	border-top: 1px solid var(--zk-line-soft);
	background: var(--zk-bg);
}

/* ---- advanced disclosure ---- */
.zcash-v2 .advanced {
	margin-top: 14px;
	border: 1px solid var(--zk-line);
	border-radius: 8px;
	overflow: hidden;
}
.zcash-v2 .advanced-toggle {
	display: flex; align-items: center; justify-content: space-between;
	width: 100%;
	padding: 12px 16px;
	font-family: var(--zk-font-display); font-size: 12.5px;
	font-weight: 500; color: var(--zk-fg-dim);
}
.zcash-v2 .advanced-toggle:hover { color: var(--zk-fg); background: var(--zk-bg-2); }
.zcash-v2 .advanced-toggle .chev { font-family: var(--zk-font-mono); color: var(--zk-fg-mute); }
.zcash-v2 .advanced-body {
	padding: 16px;
	border-top: 1px solid var(--zk-line-soft);
	background: var(--zk-bg);
}

/* ---- HISTORY ---- */
.zcash-v2 .history-controls {
	display: flex; justify-content: space-between; align-items: center;
	margin-bottom: 12px; gap: 10px; flex-wrap: wrap;
}
.zcash-v2 .filter-chip {
	font-family: var(--zk-font-display); font-size: 12px;
	color: var(--zk-fg-mute); font-weight: 500;
	padding: 6px 12px;
	border: 1px solid var(--zk-line); border-radius: 999px;
}
.zcash-v2 .filter-chip[data-active="1"] {
	color: var(--zk-bg); background: var(--zk-fg); border-color: var(--zk-fg);
}
.zcash-v2 .history-card table {
	width: 100%; border-collapse: collapse;
	font-family: var(--zk-font-display); font-size: 12.5px;
}
.zcash-v2 .history-card th {
	text-align: left;
	padding: 10px 18px;
	font-size: 11px;
	color: var(--zk-fg-mute); font-weight: 500;
	border-bottom: 1px solid var(--zk-line);
	background: var(--zk-bg);
}
.zcash-v2 .history-card th.num, .zcash-v2 .history-card td.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--zk-font-mono); }
.zcash-v2 .history-card td {
	padding: 12px 18px;
	border-bottom: 1px solid var(--zk-line-soft);
	color: var(--zk-fg-dim);
	vertical-align: middle;
}
.zcash-v2 .history-card td.block { font-family: var(--zk-font-mono); font-size: 11.5px; color: var(--zk-fg-mute); }
.zcash-v2 .history-card tr:last-child td { border-bottom: none; }
.zcash-v2 .history-card tr:hover td { background: rgba(255,255,255,0.015); }
.zcash-v2 .tx-kind {
	display: inline-flex; align-items: center; gap: 8px;
	color: var(--zk-fg-dim);
}
.zcash-v2 .tx-kind .pill {
	font-family: var(--zk-font-mono); font-size: 9.5px;
	letter-spacing: 0.1em;
	padding: 2px 6px; border-radius: 2px;
	text-transform: uppercase;
}
.zcash-v2 .tx-status {
	display: inline-flex; align-items: center; gap: 6px;
	font-size: 11.5px;
	color: var(--zk-fg-mute);
}
.zcash-v2 .tx-status::before { content: ""; width: 5px; height: 5px; border-radius: 50%; }
.zcash-v2 .tx-status.received::before { background: var(--zk-green); }
.zcash-v2 .tx-status.spent::before { background: var(--zk-fg-faint); }
.zcash-v2 .history-card .memo {
	color: var(--zk-fg-mute); font-size: 11.5px;
	display: block; max-width: 36ch;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.zcash-v2 .history-card .memo::before { content: "✉ "; color: var(--zk-gold); }

/* ---- empty state ---- */
.zcash-v2 .empty-card {
	padding: 48px 28px;
	border: 1px solid var(--zk-line);
	border-radius: 10px;
	background: var(--zk-bg-1);
	text-align: center;
}
.zcash-v2 .empty-card h3 {
	margin: 0 0 8px;
	font-family: var(--zk-font-display);
	font-size: 16px; font-weight: 600;
}
.zcash-v2 .empty-card p { margin: 0 auto; color: var(--zk-fg-dim); font-size: 13px; line-height: 1.55; max-width: 50ch; }

/* ---- responsive ---- */
@media (max-width: 1100px) {
	.zcash-v2 .form-page.with-aside { grid-template-columns: 1fr; }
	.zcash-v2 .receive-grid { grid-template-columns: 1fr; }
	.zcash-v2 .quick-actions { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
	/* Stack label above input on phones; the 80px label column gets cramped */
	.zcash-v2 .field { flex-wrap: wrap; row-gap: 4px; }
	.zcash-v2 .field .lbl { width: 100%; }
	.zcash-v2 .field input { flex: 1 0 60%; }
	.zcash-v2 .submit-row { flex-direction: column; align-items: stretch; gap: 12px; }
}
`
