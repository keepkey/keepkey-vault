/**
 * Self-serve Hive onboarding (KEEPKEY-187 / KEEPKEY-188): shown whenever the
 * sponsor refuses, so the user is never stuck. Path A here: pay for your own
 * account (account_create / create_claimed_account), signed OUTSIDE the vault
 * — the vault only builds the operation (see shared/hive-onboarding). Path B
 * (bring an existing account, KEEPKEY-188) follows.
 *
 * Preflight-console vocabulary (PreflightConsole) and the still SpinningDevice;
 * no new visual language.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Input, Spinner } from "@chakra-ui/react"
import { useUiTranslation } from "../i18n/ui"
import { rpcRequest } from "../lib/rpc"
import { generateQRSvg } from "../lib/qr"
import { PreflightCheck, PreflightList, PreflightStyles, type PreflightRow } from "./preflight/PreflightConsole"
import { SpinningDevice } from "./v3/SpinningDevice"
import {
	DEFAULT_ACCOUNT_CREATION_FEE, buildAccountCreateOp, buildCreateClaimedAccountOp,
	hiveSignUri, hiveSignerUrl, isValidHiveAccountName, normalizeHiveAccountName, operationJson,
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

export function HiveSelfServe({ keys, activeKey, initialName, onResolved }: {
	keys: HiveRoleKeys | null; activeKey: string; initialName?: string; onResolved: () => void
}) {
	const uiText = useUiTranslation()
	const [fee, setFee] = useState(DEFAULT_ACCOUNT_CREATION_FEE)
	useEffect(() => { rpcRequest<{ fee: string }>("hiveAccountCreationFee", undefined, 15000).then(r => r?.fee && setFee(r.fee)).catch(() => {}) }, [])
	// Path B (bring an existing account, KEEPKEY-188) lands in a follow-up.
	return (
		<div data-hive-selfserve="pay" style={{ display: "grid", gap: 14, marginTop: 14 }}>
			<PreflightStyles />
			<p className="kk-pf-sub" style={{ margin: 0 }}>{uiText("KeepKey couldn't sponsor this account. You can still get on Hive:")}</p>
			<PayPath keys={keys} fee={fee} initialName={initialName} activeKey={activeKey} onResolved={onResolved} />
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

function PayPath({ keys, fee, initialName, activeKey, onResolved }: { keys: HiveRoleKeys | null; fee: string; initialName?: string; activeKey: string; onResolved: () => void }) {
	const uiText = useUiTranslation()
	const [nameInput, setNameInput] = useState(initialName ?? "")
	const [payerInput, setPayerInput] = useState("")
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
	const ready = !!keys && nameOk && payer.state === "found"
	const op = useMemo<HiveOperation | null>(() => {
		if (!ready || !keys) return null
		return claimed
			? buildCreateClaimedAccountOp({ creator: payer.name, newAccountName: name, keys })
			: buildAccountCreateOp({ creator: payer.name, newAccountName: name, keys, fee })
	}, [ready, keys, claimed, payer.name, name, fee])

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
		{tokens > 0 && (
			<PreflightCheck checked={useToken} onChange={setUseToken}>{uiText("Use an account creation token (no HIVE spent)")}</PreflightCheck>
		)}
		<PreflightList rows={rows} />
		{op && <SignPanel op={op} signer={payer.name} activeKey={activeKey} onResolved={onResolved} />}
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
