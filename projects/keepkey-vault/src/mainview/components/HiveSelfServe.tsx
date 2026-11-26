/**
 * Self-serve Hive onboarding (KEEPKEY-187 / KEEPKEY-188): shown whenever the
 * sponsor refuses, so the user is never stuck. Two paths, both signed OUTSIDE
 * the vault — the vault only builds the operation (see shared/hive-onboarding):
 *
 *   A) Pay for your own account  — account_create / create_claimed_account
 *   B) Bring your Hive account   — account_update moving active/posting/memo
 *
 * Preflight-console vocabulary (PreflightConsole) and the still SpinningDevice;
 * no new visual language. Hive's mark comes from ChainNode (official logo).
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Input, Spinner } from "@chakra-ui/react"
import { useUiTranslation } from "../i18n/ui"
import { rpcRequest } from "../lib/rpc"
import { generateQRSvg } from "../lib/qr"
import { ChainNode, PreflightCheck, PreflightList, PreflightStyles, type PreflightRow } from "./preflight/PreflightConsole"
import { SpinningDevice } from "./v3/SpinningDevice"
import {
	DEFAULT_ACCOUNT_CREATION_FEE, buildAccountCreateOp, buildCreateClaimedAccountOp, buildKeyRotationOp, buildOwnerRotationOp,
	hiveSignUri, hiveSignerUrl, isValidHiveAccountName, isValidHivePublicKey, normalizeHiveAccountName, operationJson, planKeyRotation,
	type HiveAccountAuthorities, type HiveOperation, type HiveRoleKeys,
} from "../../shared/hive-onboarding"

type Lookup = { name: string; state: "idle" | "loading" | "found" | "missing" | "error"; account?: HiveAccountAuthorities }

/** Debounced account lookup by name (read-only, public Hive nodes). */
function useAccountLookup(input: string): Lookup {
	const name = normalizeHiveAccountName(input)
	const [res, setRes] = useState<Lookup>({ name: "", state: "idle" })
	useEffect(() => {
		if (!isValidHiveAccountName(name)) { setRes({ name, state: "idle" }); return }
		let cancelled = false
		setRes({ name, state: "loading" })
		const t = setTimeout(() => {
			rpcRequest<{ found: boolean; account?: HiveAccountAuthorities }>("hiveLookupAccount", { name }, 15000)
				.then(r => { if (!cancelled) setRes(r.found && r.account ? { name, state: "found", account: r.account } : { name, state: "missing" }) })
				.catch(() => { if (!cancelled) setRes({ name, state: "error" }) })
		}, 400)
		return () => { cancelled = true; clearTimeout(t) }
	}, [name])
	return res
}

const balanceHive = (balance?: string): number => {
	const m = /^(\d+(?:\.\d+)?) HIVE$/.exec(balance ?? "")
	return m ? Number(m[1]) : NaN
}

export type HiveSelfServeMode = "choose" | "pay" | "bring"

export function HiveSelfServe({ keys, activeKey, initialName, onResolved, initialMode = "choose" }: {
	keys: HiveRoleKeys | null; activeKey: string; initialName?: string; onResolved: () => void
	/** "bring" when the user already said they have an account (409 copy). */
	initialMode?: HiveSelfServeMode
}) {
	const uiText = useUiTranslation()
	const [mode, setMode] = useState<HiveSelfServeMode>(initialMode)
	const [fee, setFee] = useState(DEFAULT_ACCOUNT_CREATION_FEE)
	useEffect(() => { rpcRequest<{ fee: string }>("hiveAccountCreationFee", undefined, 15000).then(r => r?.fee && setFee(r.fee)).catch(() => {}) }, [])

	return (
		<div className="kk-pf-selfserve" data-hive-selfserve={mode} style={{ display: "grid", gap: 14, marginTop: 14 }}>
			<PreflightStyles />
			{mode === "choose" && (<>
				<p className="kk-pf-sub" style={{ margin: 0 }}>{uiText("KeepKey couldn't sponsor this account. You can still get on Hive:")}</p>
				<div className="kk-pf-tl">
					<button type="button" className="kk-pf-item kk-pf-link" style={{ textDecoration: "none", color: "inherit" }} data-hive-path="pay" onClick={() => setMode("pay")}>
						<ChainNode chainId="hive" />
						<div><b>{uiText("Pay for your own account")}</b><p>{uiText("You or a friend with a Hive account pays the {{fee}} creation fee. The new account uses this KeepKey's keys.", { fee })}</p></div>
					</button>
					<button type="button" className="kk-pf-item kk-pf-link" style={{ textDecoration: "none", color: "inherit" }} data-hive-path="bring" onClick={() => setMode("bring")}>
						<ChainNode chainId="hive" />
						<div><b>{uiText("Bring your Hive account")}</b><p>{uiText("Already have a Hive account? Move its active and posting keys to this KeepKey.")}</p></div>
					</button>
				</div>
			</>)}
			{mode !== "choose" && (
				<button type="button" className="kk-pf-link" style={{ justifySelf: "start" }} onClick={() => setMode("choose")}>{uiText("Back")}</button>
			)}
			{mode === "pay" && <PayPath keys={keys} fee={fee} initialName={initialName} activeKey={activeKey} onResolved={onResolved} />}
			{mode === "bring" && <BringPath keys={keys} activeKey={activeKey} onResolved={onResolved} />}
		</div>
	)
}

function DeviceHeader({ title, sub }: { title: string; sub: string }) {
	return (
		<div className="kk-pf-device">
			<SpinningDevice motion="still" scale={0.3} showWordmark={false}
				screen={<div style={{ fontSize: 22, letterSpacing: ".08em", textAlign: "center", width: "100%" }}>HIVE</div>} />
			<div style={{ minWidth: 0 }}>
				<h3 className="kk-pf-h">{title}</h3>
				<p className="kk-pf-sub">{sub}</p>
			</div>
		</div>
	)
}

const fieldStyle = { bg: "var(--surface-1)", border: "1px solid", borderColor: "var(--border)", fontSize: "14px" } as const

/** Optional KeepKey Client posting key: authorized next to the KeepKey's own
 *  posting key (either can post), so the browser can publish long posts the
 *  device cannot fit. Never owner or active. */
function useBrowserPostingKey() {
	const [value, setValue] = useState("")
	const key = value.trim()
	const valid = !key || isValidHivePublicKey(key)
	return { value, setValue, key: key && valid ? key : undefined, invalid: !valid }
}

function BrowserPostingKeyField({ field }: { field: ReturnType<typeof useBrowserPostingKey> }) {
	const uiText = useUiTranslation()
	return (
		<label className="kk-pf-facts" style={{ gap: 6 }}>
			<span className="kk-pf-dim" style={{ fontSize: 12 }}>{uiText("KeepKey Client posting key (optional)")}</span>
			<Input {...fieldStyle} value={field.value} onChange={e => field.setValue(e.target.value)} placeholder="STM" autoCapitalize="none" autoCorrect="off" spellCheck={false} data-hive-field="browser-posting" />
			<span className="kk-pf-dim" style={{ fontSize: 11 }}>{field.invalid ? uiText("Not a valid Hive public key.") : uiText("Lets the KeepKey Client publish long posts. It can post and vote, never move funds.")}</span>
		</label>
	)
}

function PayPath({ keys, fee, initialName, activeKey, onResolved }: { keys: HiveRoleKeys | null; fee: string; initialName?: string; activeKey: string; onResolved: () => void }) {
	const uiText = useUiTranslation()
	const [nameInput, setNameInput] = useState(initialName ?? "")
	const [payerInput, setPayerInput] = useState("")
	const browser = useBrowserPostingKey()
	const [useToken, setUseToken] = useState(true)
	const name = normalizeHiveAccountName(nameInput)
	const [avail, setAvail] = useState<{ name: string; available: boolean } | null>(null)
	useEffect(() => {
		setAvail(null)
		if (!isValidHiveAccountName(name)) return
		let cancelled = false
		const t = setTimeout(() => {
			rpcRequest<{ available: boolean }>("hiveUsernameAvailable", { name }, 10000)
				.then(r => { if (!cancelled) setAvail({ name, available: r.available === true }) })
				.catch(() => {})
		}, 400)
		return () => { cancelled = true; clearTimeout(t) }
	}, [name])
	const payer = useAccountLookup(payerInput)
	const tokens = payer.account?.pending_claimed_accounts ?? 0
	const claimed = tokens > 0 && useToken
	const feeNumber = Number(fee.split(" ")[0])
	const shortOnHive = !claimed && payer.state === "found" && balanceHive(payer.account?.balance) < feeNumber

	const nameOk = avail?.name === name && avail.available
	const ready = !!keys && nameOk && payer.state === "found" && !browser.invalid
	const op = useMemo<HiveOperation | null>(() => {
		if (!ready || !keys) return null
		return claimed
			? buildCreateClaimedAccountOp({ creator: payer.name, newAccountName: name, keys, browserPostingKey: browser.key })
			: buildAccountCreateOp({ creator: payer.name, newAccountName: name, keys, fee, browserPostingKey: browser.key })
	}, [ready, keys, claimed, payer.name, name, fee, browser.key])

	const rows: PreflightRow[] = []
	if (name) rows.push(nameOk
		? { key: "name", status: "ok", title: uiText("@{{name}} is available", { name }) }
		: { key: "name", status: avail ? "block" : "warn", title: avail ? uiText("That name is taken or invalid.") : uiText("Checking the name…") })
	if (payer.state === "missing") rows.push({ key: "payer", status: "block", title: uiText("Paying account not found.") })
	if (payer.state === "error") rows.push({ key: "payer", status: "block", title: uiText("Couldn't reach the Hive network. Try again shortly.") })
	if (payer.state === "found") rows.push({
		key: "payer", status: shortOnHive ? "warn" : "ok",
		title: uiText("@{{name}} pays", { name: payer.name }),
		detail: claimed ? uiText("Spends one account creation token. No HIVE is spent.")
			: shortOnHive ? uiText("The paying account may not hold enough HIVE for the {{fee}} fee.", { fee })
			: uiText("Spends the {{fee}} creation fee.", { fee }),
	})
	rows.push({ key: "keys", status: "ok", title: uiText("Uses this KeepKey's keys"), detail: uiText("The new account's owner, active, posting and memo keys are this KeepKey's public keys. Only this KeepKey can sign for it.") })

	return (<>
		<DeviceHeader title={uiText("Pay for your own account")} sub={uiText("You or a friend with a Hive account pays the {{fee}} creation fee. The new account uses this KeepKey's keys.", { fee })} />
		<label className="kk-pf-facts" style={{ gap: 6 }}>
			<span className="kk-pf-dim" style={{ fontSize: 12 }}>{uiText("New account name")}</span>
			<Input {...fieldStyle} value={nameInput} onChange={e => setNameInput(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} data-hive-field="name" />
		</label>
		<label className="kk-pf-facts" style={{ gap: 6 }}>
			<span className="kk-pf-dim" style={{ fontSize: 12 }}>{uiText("The Hive account that pays (yours or a friend's)")}</span>
			<Input {...fieldStyle} value={payerInput} onChange={e => setPayerInput(e.target.value)} placeholder="@" autoCapitalize="none" autoCorrect="off" spellCheck={false} data-hive-field="payer" />
		</label>
		<BrowserPostingKeyField field={browser} />
		{tokens > 0 && (
			<PreflightCheck checked={useToken} onChange={setUseToken}>{uiText("Use an account creation token (no HIVE spent)")}</PreflightCheck>
		)}
		<PreflightList rows={rows} />
		{op && <SignPanel op={op} signer={payer.name} activeKey={activeKey} onResolved={onResolved} />}
	</>)
}

function BringPath({ keys, activeKey, onResolved }: { keys: HiveRoleKeys | null; activeKey: string; onResolved: () => void }) {
	const uiText = useUiTranslation()
	const [input, setInput] = useState("")
	const browser = useBrowserPostingKey()
	const [keepApps, setKeepApps] = useState(true)
	const [keepActiveAccounts, setKeepActiveAccounts] = useState(true)
	const [showOwner, setShowOwner] = useState(false)
	const lookup = useAccountLookup(input)
	const account = lookup.state === "found" ? lookup.account! : null
	const plan = account && keys ? planKeyRotation(account, keys) : null
	const op = account && keys && plan && !plan.alreadyOnKeepKey
		&& !browser.invalid
		? buildKeyRotationOp(account, keys, { keepPostingAccountAuths: keepApps, keepActiveAccountAuths: keepActiveAccounts, browserPostingKey: browser.key })
		: null
	const ownerOp = account && keys && plan && !plan.ownerOnKeepKey ? buildOwnerRotationOp(account, keys) : null

	const rows: PreflightRow[] = []
	if (lookup.state === "missing") rows.push({ key: "acct", status: "block", title: uiText("Account not found.") })
	if (lookup.state === "error") rows.push({ key: "acct", status: "block", title: uiText("Couldn't reach the Hive network. Try again shortly.") })
	if (plan?.alreadyOnKeepKey) rows.push({ key: "done", status: "ok", title: uiText("This account already uses this KeepKey's keys.") })
	if (plan && !plan.alreadyOnKeepKey) {
		const apps = plan.postingApps.map(([n]) => n).join(", ")
		const accounts = plan.activeAccounts.map(([n]) => n).join(", ")
		rows.push(
			{ key: "active", status: "warn", title: uiText("Active key → this KeepKey"), detail: uiText("Replaces the current active keys. Transfers and wallet actions will need your KeepKey.") },
			{ key: "posting", status: "warn", title: uiText("Posting key → this KeepKey"), detail: uiText("Replaces the current posting keys. Posts, votes and comments will need your KeepKey.") },
		)
		if (plan.memoChanges) rows.push({ key: "memo", status: "ok", title: uiText("Memo key → this KeepKey") })
		rows.push({ key: "owner", status: "ok", title: uiText("Owner key stays as it is"), detail: uiText("Your master password or owner key remains the recovery path. Keep it offline.") })
		if (plan.postingApps.length) rows.push({
			key: "apps", status: keepApps ? "ok" : "warn", title: uiText("Apps with posting access"),
			detail: <PreflightCheck checked={keepApps} onChange={setKeepApps}>{uiText("Keep {{apps}}", { apps })}</PreflightCheck>,
		})
		if (plan.activeAccounts.length) rows.push({
			key: "activeAccounts", status: "warn", title: uiText("Accounts with active access"),
			detail: <PreflightCheck checked={keepActiveAccounts} onChange={setKeepActiveAccounts}>{uiText("Keep {{accounts}}", { accounts })}</PreflightCheck>,
		})
		if (plan.droppedForMultisig.length) rows.push({
			key: "multisig", status: "danger", title: uiText("Multisig authority"),
			detail: uiText("{{accounts}} will be removed so no account gains control alone.", { accounts: plan.droppedForMultisig.join(", ") }),
		})
	}

	return (<>
		<DeviceHeader title={uiText("Bring your Hive account")} sub={uiText("Today your keys live in a browser wallet. After this, only your KeepKey signs with the active and posting keys.")} />
		<label className="kk-pf-facts" style={{ gap: 6 }}>
			<span className="kk-pf-dim" style={{ fontSize: 12 }}>{uiText("Your Hive account")}</span>
			<Input {...fieldStyle} value={input} onChange={e => setInput(e.target.value)} placeholder="@" autoCapitalize="none" autoCorrect="off" spellCheck={false} data-hive-field="account" />
		</label>
		<BrowserPostingKeyField field={browser} />
		{lookup.state === "loading" && <Spinner size="sm" />}
		{rows.length > 0 && <PreflightList rows={rows} />}
		{op && account && (<>
			<p className="kk-pf-sub" style={{ margin: 0 }}>{uiText("Sign it with the account's current active key.")}</p>
			<SignPanel op={op} signer={account.name} activeKey={activeKey} onResolved={onResolved} />
		</>)}
		{plan?.alreadyOnKeepKey && <ResolveWatcher activeKey={activeKey} onResolved={onResolved} />}
		{ownerOp && account && (
			<details className="kk-pf-tech" open={showOwner} onToggle={e => setShowOwner((e.target as HTMLDetailsElement).open)}>
				<summary>{uiText("Also move the owner key (optional)")}</summary>
				<div style={{ display: "grid", gap: 12, marginTop: 10 }}>
					<PreflightList rows={[{ key: "ownerWarn", status: "danger", title: uiText("Owner key → this KeepKey"),
						detail: uiText("Signs with your master password or owner key on HiveSigner. Afterwards the old master password no longer recovers this account, and only this KeepKey can. Back up your KeepKey recovery sentence first.") }]} />
					{showOwner && <SignPanel op={ownerOp} signer={account.name} activeKey={activeKey} onResolved={() => {}} watch={false} />}
				</div>
			</details>
		)}
	</>)
}

/** Polls Pioneer's pubkey → account lookup until this KeepKey's active key controls an account. */
function ResolveWatcher({ activeKey, onResolved }: { activeKey: string; onResolved: () => void }) {
	const uiText = useUiTranslation()
	const done = useRef(false)
	const resolved = useRef(onResolved)
	resolved.current = onResolved
	useEffect(() => {
		let stopped = false
		const deadline = Date.now() + 15 * 60_000
		const tick = async () => {
			if (stopped || done.current) return
			try {
				const r = await rpcRequest<{ account?: unknown }>("hiveGetAccount", { pubkey: activeKey }, 15000)
				if (r?.account && !stopped) { done.current = true; resolved.current(); return }
			} catch { /* keep polling */ }
			if (!stopped && Date.now() < deadline) setTimeout(tick, 5000)
		}
		const first = setTimeout(tick, 3000)
		return () => { stopped = true; clearTimeout(first) }
	}, [activeKey])
	return (
		<div className="kk-pf-hint" data-hive-waiting style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center" }}>
			<Spinner size="xs" />{uiText("Waiting for the account on chain…")}
		</div>
	)
}

/** QR (hive-uri) + HiveSigner link + copy, then wait for the account to appear. */
function SignPanel({ op, signer, activeKey, onResolved, watch = true }: { op: HiveOperation; signer: string; activeKey: string; onResolved: () => void; watch?: boolean }) {
	const uiText = useUiTranslation()
	const [copied, setCopied] = useState<"op" | "uri" | null>(null)
	const uri = hiveSignUri(op, signer)
	const qr = useMemo(() => { try { return generateQRSvg(uri, 3, 2) } catch { return "" } }, [uri])
	const copy = (what: "op" | "uri") => {
		navigator.clipboard?.writeText(what === "op" ? operationJson(op) : uri).catch(() => {})
		setCopied(what); setTimeout(() => setCopied(null), 1200)
	}
	return (
		<div data-hive-sign={op[0]} style={{ display: "grid", gap: 12 }}>
			<h3 className="kk-pf-h">{uiText("Sign outside the vault")}</h3>
			<div className="kk-pf-actions kk-pf-wrap">
				<button type="button" className="kk-pf-go" data-hive-open-hivesigner
					onClick={() => rpcRequest("openUrl", { url: hiveSignerUrl(op) }).catch(() => {})}>{uiText("Open in HiveSigner")}</button>
				<button type="button" className="kk-pf-outline" data-hive-copy-op onClick={() => copy("op")}>{copied === "op" ? uiText("Copied") : uiText("Copy operation")}</button>
				<button type="button" className="kk-pf-outline" data-hive-copy-uri onClick={() => copy("uri")}>{copied === "uri" ? uiText("Copied") : uiText("Copy hive:// link")}</button>
			</div>
			{qr && (
				<div style={{ display: "grid", justifyItems: "center", gap: 8 }}>
					<div data-hive-qr style={{ width: 200, maxWidth: "100%", borderRadius: 10, overflow: "hidden", lineHeight: 0 }}
						dangerouslySetInnerHTML={{ __html: qr.replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"') }} />
					<p className="kk-pf-hint" style={{ margin: 0 }}>{uiText("Scan with a Hive mobile wallet. If your wallet can't open it, use HiveSigner or copy the operation.")}</p>
				</div>
			)}
			<dl className="kk-pf-facts" style={{ margin: 0 }}>
				<div><dt>{uiText("Signer")}</dt><dd>@{signer}</dd></div>
				<div><dt>{uiText("Operation")}</dt><dd>{op[0]}</dd></div>
			</dl>
			{watch && <ResolveWatcher activeKey={activeKey} onResolved={onResolved} />}
		</div>
	)
}
