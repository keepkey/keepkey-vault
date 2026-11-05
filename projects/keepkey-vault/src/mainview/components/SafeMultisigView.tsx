import { useUiTranslation } from "../i18n/ui"
import { useEffect, useRef, useState } from "react";
import { utils } from "ethers";
import { rpcRequest } from "../lib/rpc";
import type {
  SafeAccount,
  SafeContext,
  SafeProposal,
  SafeTransfer,
  SafeTxReview,
} from "../../shared/safe-multisig";
import "./SafeMultisigView.css";
import {
  safeVaultIdentity,
  BASE_NETWORK,
  BASE_ETH_CAIP,
  BASE_USDC_CAIP,
} from "../../shared/vault-identity";
import { SAFE_USDC } from "../../shared/safe-multisig";
import { VaultIdentityBadge, VaultIdentityDetails } from "./VaultIdentityBadge";

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function transfer(p: SafeProposal): SafeTransfer {
  const t = p.transaction;
  if (t.data === "0x")
    return {
      asset: "ETH",
      amount: utils.formatEther(t.value),
      recipient: t.to,
    };
  const [recipient, amount] = utils.defaultAbiCoder.decode(
    ["address", "uint256"],
    "0x" + t.data.slice(10)
  );
  return { asset: "USDC", recipient, amount: utils.formatUnits(amount, 6) };
}
function Shield({ large = false }: { large?: boolean }) {
  return (
    <svg
      width={large ? 42 : 20}
      height={large ? 42 : 20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2 3 6v6c0 5 5 8 9 10 4-2 9-5 9-10V6z" />
      <circle cx="9" cy="10" r="2" />
      <circle cx="15" cy="10" r="2" />
      <path d="M5.5 16c0-2 1.5-3 3.5-3s3.5 1 3.5 3m-1 0c0-2 1.5-3 3.5-3s3.5 1 3.5 3" />
    </svg>
  );
}
function TransferIdentity({ value }: { value: SafeTransfer }) {
  const uiText = useUiTranslation()

  const decimals = value.asset === "ETH" ? 18 : 6;
  return (
    <div className="safe-transfer-identity">
      <div>{uiText("Network:")}{" "}<code>{BASE_NETWORK}</code>
      </div>
      <div>{uiText("Asset:")}{" "}
        <code>{value.asset === "ETH" ? BASE_ETH_CAIP : BASE_USDC_CAIP}</code>
      </div>
      {value.asset === "USDC" && (
        <div>{uiText("Native Base USDC contract:")}{" "}<code>{SAFE_USDC}</code>
        </div>
      )}
      <div>
        {decimals}{" "}{uiText("decimals · raw amount")}{" "}
        <code>{utils.parseUnits(value.amount, decimals).toString()}</code>
      </div>
    </div>
  );
}
function Address({ value }: { value: string }) {
  const uiText = useUiTranslation()

  const [copied, setCopied] = useState(false);
  return (
    <button
      className="safe-address"
      title={uiText("Copy address")}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      <span>{value}</span>
      <span className="safe-copy">{copied ? uiText("Copied") : uiText("Copy")}</span>
    </button>
  );
}
function Explorer({
  hash,
  address = false,
}: {
  hash: string;
  address?: boolean;
}) {
  const uiText = useUiTranslation()

  return (
    <button
      className="safe-link"
      onClick={() => {
        void rpcRequest("openUrl", {
          url: `https://basescan.org/${address ? "address" : "tx"}/${hash}`,
        });
      }}
    >{uiText("View on BaseScan ↗")}</button>
  );
}
function exportProposal(p: SafeProposal) {
  const { executionTx: _, ...publicProposal } = p;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(publicProposal, null, 2) + "\n"], {
      type: "application/json",
    })
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `base-safe-${p.transaction.nonce}-${p.hash.slice(2, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SafeMultisigView({
  initialAddress = "",
  initialCreate = false,
  embedded = false,
  initialCompose = false,
  assetOnly,
  onBusyChange,
}: {
  initialAddress?: string;
  initialCreate?: boolean;
  embedded?: boolean;
  initialCompose?: boolean;
  assetOnly?: "ETH" | "USDC";
  onBusyChange?: (busy: boolean) => void;
}) {
  const uiText = useUiTranslation()

  const [context, setContext] = useState<SafeContext>();
  const [selected, setSelected] = useState(initialAddress);
  const [mode, setMode] = useState<"home" | "create" | "import">(
    initialCreate ? "create" : "home"
  );
  const [review, setReview] = useState<SafeTxReview>();
  const [importReview, setImportReview] = useState<SafeAccount>();
  const [selectedHash, setSelectedHash] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("My Base Safe");
  const [owners, setOwners] = useState([""]);
  const [threshold, setThreshold] = useState(2);
  const [saltNonce, setSaltNonce] = useState("");
  const [importAddress, setImportAddress] = useState("");
  const [asset, setAsset] = useState<"ETH" | "USDC">(assetOnly || "ETH");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [compose, setCompose] = useState(initialCompose);
  const [rpcUrl, setRpcUrl] = useState("https://mainnet.base.org");
  const [providerOpen, setProviderOpen] = useState(false);
  const setupFile = useRef<HTMLInputElement>(null);
  const proposalFile = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const session = useRef("");
  const initialRouteHandled = useRef(false);
  const safe = context?.accounts.find((a) =>
    eq(a.address, embedded ? initialAddress : selected)
  );
  const proposals =
    context?.proposals.filter(
      (p) =>
        safe &&
        eq(p.safe, safe.address) &&
        (!assetOnly || transfer(p).asset === assetOnly)
    ) || [];
  const proposal = proposals.find((p) => p.hash === selectedHash);
  const isOwner = !!safe?.owners.some((o) => context && eq(o, context.owner));

  const load = async () => {
    const next = await rpcRequest<SafeContext>("safeList", undefined, 0);
    if (!alive.current) return next;
    if (embedded && !next.accounts.some((a) => eq(a.address, initialAddress)))
      throw new Error(
        "Selected Safe account is unavailable in this wallet session. Re-select and verify the vault account."
      );
    if (session.current && session.current !== next.session) {
      setReview(undefined);
      setImportReview(undefined);
      setSelectedHash("");
      setCompose(false);
      setMode("home");
      setOwners([""]);
      setSaltNonce("");
      setRecipient("");
      setAmount("");
    }
    session.current = next.session;
    setContext(next);
    if (!initialRouteHandled.current) {
      initialRouteHandled.current = true;
      if (
        initialAddress &&
        !next.accounts.some((a) => eq(a.address, initialAddress))
      ) {
        setImportAddress(initialAddress);
        setSelected("");
        setMode("import");
        return next;
      }
    }
    setSelected((old) =>
      next.accounts.some((a) => eq(a.address, old))
        ? old
        : next.accounts[0]?.address || ""
    );
    return next;
  };
  useEffect(() => {
    alive.current = true;
    void load().catch((e) => {
      if (alive.current) setError(e.message);
    });
    void rpcRequest<{ evmSimulationRpcUrls: Record<string, string> }>(
      "getAppSettings"
    )
      .then((s) => {
        if (alive.current && s.evmSimulationRpcUrls?.["8453"])
          setRpcUrl(s.evmSimulationRpcUrls["8453"]);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange?.(!!busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const run = async (message: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(message);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy("");
    }
  };
  const verifySession = async () => {
    const current = await rpcRequest<SafeContext>("safeList", undefined, 0);
    if (!alive.current || current.session !== session.current)
      throw new Error("Wallet changed. Reopen Multisig and review again.");
  };
  const signReview = () =>
    run("Confirm the transaction on your KeepKey…", async () => {
      if (!review) return;
      if (
        embedded &&
        (!eq(review.safe.address, initialAddress) ||
          (review.transfer && assetOnly && review.transfer.asset !== assetOnly))
      )
        throw new Error(
          "Transaction differs from the selected vault account or asset"
        );
      await verifySession();
      if (review.expiresAt <= Date.now())
        throw new Error("Review expired. Go back and refresh the transaction.");
      const result = await rpcRequest<any>("ethSignTx", review.transaction, 0);
      await verifySession();
      const serialized = result?.serialized ?? result?.serializedTx;
      if (typeof serialized !== "string")
        throw new Error("KeepKey did not return a signed transaction");
      setBusy("Submitting to Base…");
      const sent = await rpcRequest<{ txid: string }>(
        "safeBroadcast",
        { reviewId: review.id, signedTx: serialized },
        0
      );
      await load();
      setSelected(review.safe.address);
      setReview(undefined);
      setMode("home");
      setCompose(false);
      setNotice(
        `Submitted to Base: ${sent.txid}. Refresh to check the deployed account.`
      );
    });
  const approve = () =>
    run("Confirm the owner approval on your KeepKey…", async () => {
      if (!proposal) return;
      await verifySession();
      const signing = await rpcRequest<any>(
        "safeSigningData",
        { hash: proposal.hash },
        0
      );
      const result = await rpcRequest<{ signature: string }>(
        "ethSignTypedData",
        signing,
        0
      );
      await verifySession();
      await rpcRequest(
        "safeAddSignature",
        { hash: proposal.hash, signature: result.signature },
        0
      );
      await load();
      setNotice(
        "KeepKey approval added. Export the proposal to collect the other owner’s approval."
      );
    });
  const loadSetup = (file: File) =>
    run("Loading prepared setup…", async () => {
      if (file.size > 40_000) throw new Error("Setup file is too large");
      const p = JSON.parse(await file.text());
      if (
        !context ||
        p.chainId !== 8453 ||
        p.safeVersion !== "1.4.1" ||
        !Array.isArray(p.owners) ||
        !p.owners.some((a: string) => eq(a, context.owner))
      )
        throw new Error(
          "Choose the prepared Base Safe deployment review for this KeepKey owner"
        );
      const others = p.owners.filter((a: string) => !eq(a, context.owner));
      if (
        !others.length ||
        others.length > 19 ||
        typeof p.saltNonce !== "string"
      )
        throw new Error("Invalid prepared setup");
      setOwners(others);
      setThreshold(p.threshold);
      setSaltNonce(p.saltNonce);
      setImportReview(undefined);
      setReview(undefined);
      setMode("create");
      setNotice(
        "Prepared owners and salt loaded. The next step re-verifies the contracts, address and current fees on Base."
      );
    });
  const importProposal = (file: File) =>
    run("Verifying owner approvals…", async () => {
      if (file.size > 40_000) throw new Error("Proposal file is too large");
      const p = await rpcRequest<SafeProposal>(
        "safeImportProposal",
        {
          json: await file.text(),
          ...(embedded
            ? { expectedSafe: initialAddress, expectedAsset: assetOnly }
            : {}),
        },
        0
      );
      await load();
      setSelected(p.safe);
      setSelectedHash(p.hash);
      setNotice(
        "Proposal verified. Review the transfer before adding your approval."
      );
    });
  const choose = (address: string) => {
    setSelected(address);
    setSelectedHash("");
    setMode("home");
    setCompose(false);
    setReview(undefined);
    setImportReview(undefined);
    setError("");
    setNotice("");
  };
  const pending = !!safe && !safe.deployed;

  return (
    <section
      className={`safe-view${embedded ? " safe-embedded" : ""}`}
      aria-label={uiText("Safe multisig")}
    >
      <input
        ref={setupFile}
        type="file"
        accept=".json,application/json"
        hidden
        aria-label={uiText("Prepared Safe setup file")}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void loadSetup(f);
        }}
      />
      <input
        ref={proposalFile}
        type="file"
        accept=".json,application/json"
        hidden
        aria-label={uiText("Safe proposal file")}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void importProposal(f);
        }}
      />
      <header className="safe-header">
        <div>
          <div className="safe-eyebrow">
            <Shield />{" "}{uiText("SAFE MULTISIG")}{" "}
            <span className="safe-base">
              <i />{uiText("Base")}</span>
          </div>
          <h1>{uiText("Shared control.")}<br />
            <span>{uiText("Secured by KeepKey.")}</span>
          </h1>
          <p>{uiText("Create a Safe, collect owner approvals, and move funds together.")}</p>
        </div>
        <div className="safe-owner">
          <span className="safe-caption">{uiText("CONNECTED KEEPKEY · ACCOUNT 0")}</span>
          {context ? (
            <>
              <Address value={context.owner} />
              <span className="safe-caption">
                {context.sessionOnly
                  ? uiText("Hidden wallet · saved for this session only")
                  : "m/44′/60′/0′/0/0"}
              </span>
            </>
          ) : (
            <span className="safe-muted">{uiText("Connecting to your wallet…")}</span>
          )}
        </div>
      </header>
      {embedded && context && (
        <div className="safe-embedded-owner">{uiText("Owner signing and execution gas: KeepKey account 0")}<Address value={context.owner} />
        </div>
      )}
      {context && (
        <details
          className="safe-provider"
          open={providerOpen || context.rpcReady === false}
          onToggle={(e) => setProviderOpen(e.currentTarget.open)}
        >
          <summary>{uiText("Base provider ·")}{" "}{context.rpcSource || uiText("Pioneer")}
            {context.rpcReady === false ? uiText(" · configuration needed") : ""}
          </summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run("Checking the Base RPC provider…", async () => {
                await rpcRequest(
                  "setEvmSimulationRpc",
                  { chainId: 8453, url: rpcUrl },
                  0
                );
                await load();
                setReview(undefined);
                setProviderOpen(false);
                setNotice(
                  "Base RPC configured. Safe reads, simulations and submissions will use this endpoint."
                );
              });
            }}
          >
            <p className="safe-muted">
              {context.rpcReady === false
                ? uiText("Your Pioneer server does not expose the Safe contract reads. Choose a Base RPC endpoint to continue.")
                : uiText("Safe contract reads, simulations and submissions use this provider.")}{" "}{uiText("This also updates the Base simulation provider in Settings.")}</p>
            <div className="safe-input-row">
              <label>{uiText("Base RPC URL")}<input
                  type="url"
                  required
                  value={rpcUrl}
                  onChange={(e) => setRpcUrl(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <button disabled={!!busy} className="safe-button" type="submit">{uiText("Verify & use RPC")}</button>
            </div>
            <button
              disabled={!!busy}
              type="button"
              className="safe-link"
              onClick={() =>
                void run("Selecting Pioneer…", async () => {
                  await rpcRequest(
                    "setEvmSimulationRpc",
                    { chainId: 8453, url: "" },
                    0
                  );
                  await load();
                  setReview(undefined);
                })
              }
            >{uiText("Use Pioneer")}</button>
          </form>
        </details>
      )}
      {error && (
        <div className="safe-alert safe-error" role="alert">
          {error}
          <button aria-label={uiText("Dismiss error")} onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {notice && (
        <div className="safe-alert" role="status">
          {notice}
        </div>
      )}
      {busy && (
        <div className="safe-busy" role="status">
          <span className="safe-spinner" />
          {busy}
        </div>
      )}
      {!context && !busy && error && (
        <button
          className="safe-button"
          onClick={() =>
            void run("Connecting…", async () => {
              await load();
            })
          }
        >{uiText("Retry connection")}</button>
      )}
      {context && (
        <fieldset className="safe-workspace" disabled={!!busy}>
          <aside className="safe-sidebar">
            <div className="safe-sidebar-heading">
              <span className="safe-caption">{uiText("YOUR SAFES")}</span>
              <span>{context.accounts.length.toString().padStart(2, "0")}</span>
            </div>
            {context.accounts.map((a) => (
              <button
                key={a.address}
                className={`safe-account ${
                  safe?.address === a.address && mode === "home" ? "active" : ""
                }`}
                onClick={() => choose(a.address)}
              >
                <span className="safe-account-icon">
                  <Shield />
                </span>
                <span>
                  <strong>{a.name}</strong>
                  <small>{short(a.address)}</small>
                  <small>
                    {a.threshold}{" "}{uiText("of")}{" "}{a.owners.length}{" "}{uiText("owners ·")}{" "}
                    {a.deployed
                      ? uiText("Base")
                      : a.deploymentTx
                      ? uiText("Deployment pending")
                      : uiText("Setup saved · not deployed")}
                  </small>
                </span>
              </button>
            ))}
            {!context.accounts.length && (
              <p className="safe-muted safe-sidebar-empty">{uiText("Your shared accounts will appear here.")}</p>
            )}
            <button
              className={`safe-button ${mode === "create" ? "selected" : ""}`}
              onClick={() => {
                setMode("create");
                setImportReview(undefined);
                setReview(undefined);
                setError("");
              }}
            >{uiText("＋ Create a Safe")}</button>
            <button
              className="safe-button safe-secondary"
              onClick={() => {
                setMode("import");
                setImportReview(undefined);
                setReview(undefined);
                setError("");
              }}
            >{uiText("Import existing Safe")}</button>
            <div className="safe-sidebar-note">
              <span className="safe-dot" />{uiText("SafeL2 v1.4.1 / v1.5.0 · Base")}<br />{uiText("Owner approvals are free.")}<br />{uiText("Deployment and execution use ETH.")}</div>
          </aside>
          <main className="safe-main">
            {importReview ? (
              <div className="safe-panel">
                <span className="safe-caption">{uiText("VERIFY VAULT CONTROL · BASE MAINNET")}</span>
                <h2>{uiText("Review owners before importing")}</h2>
                <p>{uiText("Check the full vault address, each owner, and the threshold. This configuration becomes the reference for funding checks.")}</p>
                <VaultIdentityDetails
                  vault={safeVaultIdentity(importReview, context.sessionOnly)}
                />
                {!importReview.owners.some((o) => eq(o, context.owner)) && (
                  <p className="safe-muted">{uiText("This KeepKey is not listed as an owner. Importing tracks this vault; it does not grant control.")}</p>
                )}
                <div className="safe-actions">
                  <button
                    className="safe-button safe-secondary"
                    onClick={() => setImportReview(undefined)}
                  >{uiText("Back")}</button>
                  <button
                    className="safe-button safe-primary"
                    onClick={() =>
                      void run(
                        "Re-verifying the reviewed owner configuration…",
                        async () => {
                          await verifySession();
                          const a = await rpcRequest<SafeAccount>(
                            "safeImport",
                            {
                              address: importReview.address,
                              name: importReview.name,
                              expectedOwners: importReview.owners,
                              expectedThreshold: importReview.threshold,
                            },
                            0
                          );
                          await load();
                          choose(a.address);
                          setNotice(
                            "Reviewed vault imported. Funding checks will require this exact owner configuration."
                          );
                        }
                      )
                    }
                  >{uiText("Confirm owners & import")}</button>
                </div>
              </div>
            ) : review ? (
              <div className="safe-panel safe-review">
                <span className="safe-caption">{uiText("FINAL REVIEW · BASE MAINNET")}</span>
                <h2>
                  {review.kind === "create"
                    ? uiText("Create your Safe")
                    : uiText("Execute approved transfer")}
                </h2>
                <p>
                  {review.kind === "create"
                    ? uiText("Check every owner before deploying. These addresses will control this account.")
                    : uiText("The collected owner approvals authorize this exact transaction.")}
                </p>
                <dl className="safe-facts">
                  <div>
                    <dt>{uiText("Safe address")}</dt>
                    <dd>
                      <Address value={review.safe.address} />
                    </dd>
                  </div>
                  <div>
                    <dt>{uiText("Approval threshold")}</dt>
                    <dd>
                      {review.safe.threshold}{" "}{uiText("of")}{" "}{review.safe.owners.length}{" "}{uiText("owners")}</dd>
                  </div>
                </dl>
                {review.kind === "create" && (
                  <div className="safe-owner-list">
                    {review.safe.owners.map((o, i) => (
                      <div key={o}>
                        <span>{String(i + 1).padStart(2, "0")}</span>
                        <Address value={o} />
                        <small>
                          {eq(o, context.owner) ? uiText("This KeepKey") : uiText("Co-owner")}
                        </small>
                      </div>
                    ))}
                  </div>
                )}
                {review.transfer && (
                  <div className="safe-transfer-review">
                    <strong>
                      {review.transfer.amount}{" "}
                      <span>{review.transfer.asset}</span>
                    </strong>
                    <span className="safe-caption">TO</span>
                    <Address value={review.transfer.recipient} />
                    <TransferIdentity value={review.transfer} />
                    <span className="safe-caption">{uiText("SAFE NONCE")}{" "}{review.proposal?.transaction.nonce}
                    </span>
                  </div>
                )}
                <dl className="safe-facts">
                  <div>
                    <dt>{uiText("Execution gas ceiling")}</dt>
                    <dd>{review.maximumExecutionFeeEth} ETH</dd>
                  </div>
                  <div>
                    <dt>{uiText("KeepKey ETH balance")}</dt>
                    <dd>{review.ownerBalanceEth} ETH</dd>
                  </div>
                  <div>
                    <dt>{uiText("Paid by")}</dt>
                    <dd>{uiText("Connected KeepKey · account 0")}</dd>
                  </div>
                </dl>
                <p className="safe-muted">{uiText("Base also charges an L1 data fee. The gas ceiling above excludes that fee. This review expires after five minutes.")}</p>
                <details className="safe-details">
                  <summary>{uiText("Transaction details")}</summary>
                  <span className="safe-caption">{uiText("TRANSACTION TARGET")}</span>
                  <Address value={review.transaction.to} />
                  {review.saltNonce && (
                    <p>{uiText("CREATE2 salt nonce:")}{" "}{review.saltNonce}</p>
                  )}
                  <p>{uiText("Chain: 8453 · Owner nonce:")}{" "}
                    {Number(review.transaction.nonce)}
                  </p>
                  <pre>{review.transaction.data}</pre>
                </details>
                <div className="safe-actions">
                  <button
                    className="safe-button safe-secondary"
                    onClick={() => setReview(undefined)}
                  >{uiText("Back")}</button>
                  {review.kind === "create" && (
                    <button
                      className="safe-button safe-secondary"
                      onClick={() =>
                        void run("Saving the reviewed setup…", async () => {
                          await rpcRequest(
                            "safeSaveSetup",
                            { reviewId: review.id },
                            0
                          );
                          await load();
                          setSelected(review.safe.address);
                          setReview(undefined);
                          setMode("home");
                          setNotice(
                            "Setup saved as an undeployed vault. Funding stays blocked until its deployment is confirmed."
                          );
                        })
                      }
                    >{uiText("Save setup for later")}</button>
                  )}
                  <button
                    className="safe-button safe-primary"
                    onClick={signReview}
                  >{uiText("Confirm on KeepKey & submit")}</button>
                </div>
              </div>
            ) : mode === "create" ? (
              <form
                className="safe-panel"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    "Verifying Safe contracts and simulating deployment…",
                    async () => {
                      const r = await rpcRequest<SafeTxReview>(
                        "safePrepareCreate",
                        {
                          name,
                          otherOwners: owners,
                          threshold,
                          ...(saltNonce ? { saltNonce } : {}),
                        },
                        0
                      );
                      setReview(r);
                    }
                  );
                }}
              >
                <span className="safe-caption">{uiText("NEW SHARED ACCOUNT")}</span>
                <h2>{uiText("Create a Safe on Base")}</h2>
                <p>{uiText("Add the addresses that will share control. Your connected KeepKey is the first owner.")}</p>
                <label>{uiText("Safe name")}<input
                    value={name}
                    maxLength={60}
                    required
                    onChange={(e) => setName(e.target.value)}
                    placeholder={uiText("Treasury, savings, shared funds…")}
                  />
                </label>
                <div className="safe-owner-row">
                  <span className="safe-number">01</span>
                  <div>
                    <span className="safe-caption">{uiText("YOUR KEEPKEY")}</span>
                    <Address value={context.owner} />
                  </div>
                  <span className="safe-tag">{uiText("Owner")}</span>
                </div>
                {owners.map((owner, i) => (
                  <label key={i}>{uiText("Owner")}{" "}{i + 2}
                    <div className="safe-input-row">
                      <input
                        aria-label={`Owner ${i + 2} address`}
                        value={owner}
                        onChange={(e) =>
                          setOwners((v) =>
                            v.map((a, j) => (j === i ? e.target.value : a))
                          )
                        }
                        required
                        placeholder="0x…"
                        spellCheck={false}
                      />
                      {owners.length > 1 && (
                        <button
                          type="button"
                          className="safe-link"
                          onClick={() => {
                            setOwners((v) => v.filter((_, j) => j !== i));
                            setThreshold((v) => Math.min(v, owners.length));
                          }}
                        >{uiText("Remove")}</button>
                      )}
                    </div>
                  </label>
                ))}
                {owners.length < 19 && (
                  <button
                    type="button"
                    className="safe-link"
                    onClick={() => setOwners((v) => [...v, ""])}
                  >{uiText("＋ Add another owner")}</button>
                )}
                <div className="safe-threshold">
                  <div>
                    <strong>{uiText("Required approvals")}</strong>
                    <p>{uiText("Each transaction needs this many owners.")}</p>
                  </div>
                  <select
                    aria-label={uiText("Required approvals")}
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                  >
                    {Array.from({ length: owners.length }, (_, i) => i + 2).map(
                      (n) => (
                        <option value={n} key={n}>
                          {n}{" "}{uiText("of")}{" "}{owners.length + 1}
                        </option>
                      )
                    )}
                  </select>
                </div>
                {saltNonce && (
                  <p className="safe-muted">{uiText("Prepared setup loaded · salt nonce")}{" "}{saltNonce}
                  </p>
                )}
                <div className="safe-actions">
                  <button
                    type="button"
                    className="safe-button safe-secondary"
                    onClick={() => setupFile.current?.click()}
                  >{uiText("Load prepared setup")}</button>
                  <button className="safe-button safe-primary" type="submit">{uiText("Review deployment →")}</button>
                </div>
              </form>
            ) : mode === "import" ? (
              <form
                className="safe-panel"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("Verifying the Safe on Base…", async () => {
                    setImportReview(
                      await rpcRequest<SafeAccount>(
                        "safeInspect",
                        { address: importAddress, name },
                        0
                      )
                    );
                  });
                }}
              >
                <span className="safe-caption">{uiText("EXISTING SHARED ACCOUNT")}</span>
                <h2>{uiText("Import a Safe")}</h2>
                <p>{uiText("We verify its contract, owners and approval threshold on Base before saving it.")}</p>
                <label>{uiText("Safe name")}<input
                    value={name}
                    maxLength={60}
                    required
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>{uiText("Safe contract address")}<input
                    value={importAddress}
                    required
                    placeholder="0x…"
                    spellCheck={false}
                    onChange={(e) => setImportAddress(e.target.value)}
                  />
                </label>
                <p className="safe-muted">{uiText("Supports SafeL2 v1.4.1 and v1.5.0 on Base. Use the Safe contract address, rather than an owner’s wallet address.")}</p>
                <button type="submit" className="safe-button safe-primary">{uiText("Verify & review owners →")}</button>
              </form>
            ) : !safe ? (
              <div className="safe-panel safe-empty">
                <div className="safe-empty-icon">
                  <Shield large />
                </div>
                <span className="safe-caption">{uiText("MORE THAN ONE KEY")}</span>
                <h2>{uiText("A shared account.")}<br />{uiText("A shared decision.")}</h2>
                <p>{uiText("Keep funds in a Safe smart account. Choose the owners and how many approvals each transaction needs.")}</p>
                <div className="safe-empty-steps">
                  <div>
                    <b>01</b>
                    <strong>{uiText("Choose owners")}</strong>
                    <span>{uiText("Add your KeepKey and a second wallet.")}</span>
                  </div>
                  <div>
                    <b>02</b>
                    <strong>{uiText("Set approvals")}</strong>
                    <span>{uiText("Start with two owners, two approvals.")}</span>
                  </div>
                  <div>
                    <b>03</b>
                    <strong>{uiText("Review together")}</strong>
                    <span>{uiText("Collect signatures before funds move.")}</span>
                  </div>
                </div>
                <button
                  className="safe-button safe-primary"
                  onClick={() => setMode("create")}
                >{uiText("Create your first Safe →")}</button>
                <button className="safe-link" onClick={() => setMode("import")}>{uiText("Already have one? Import a Safe")}</button>
              </div>
            ) : (
              <>
                <div className="safe-panel safe-overview">
                  <div className="safe-panel-header">
                    <div>
                      <span className="safe-caption">{uiText("BASE · SAFE v")}{safe.safeVersion || "1.4.1"}
                      </span>
                      <h2>{safe.name}</h2>
                    </div>
                    <button
                      className="safe-button safe-secondary"
                      onClick={() =>
                        void run("Refreshing account from Base…", async () => {
                          await rpcRequest(
                            "safeRefresh",
                            { address: safe.address },
                            0
                          );
                          await load();
                        })
                      }
                    >{uiText("↻ Refresh")}</button>
                  </div>
                  <Address value={safe.address} />
                  <Explorer hash={safe.address} address />
                  {safe.configurationChanged && (
                    <div className="safe-alert safe-warning">{uiText("The Safe’s owners or threshold changed. Funding is blocked until you review and accept the new configuration.")}<button
                        className="safe-button"
                        onClick={() => setImportReview(safe)}
                      >{uiText("Review changed owners")}</button>
                    </div>
                  )}
                  <div className="safe-metrics">
                    <div>
                      <span className="safe-caption">{uiText("ETH BALANCE")}</span>
                      <strong>
                        {safe.balanceEth ?? "—"} <small>ETH</small>
                      </strong>
                    </div>
                    <div>
                      <span className="safe-caption">{uiText("USDC BALANCE")}</span>
                      <strong>
                        {safe.balanceUsdc ?? "—"} <small>USDC</small>
                      </strong>
                    </div>
                    <div>
                      <span className="safe-caption">{uiText("APPROVALS REQUIRED")}</span>
                      <strong>
                        {safe.threshold}
                        <small>{" "}{uiText("of")}{" "}{safe.owners.length}</small>
                      </strong>
                    </div>
                  </div>
                  {pending ? (
                    <div className="safe-alert">
                      {safe.deploymentTx
                        ? uiText("Deployment submitted. Refresh after Base confirms the transaction.")
                        : uiText("Setup saved. This Safe is not deployed. Do not fund this address yet.")}
                      {safe.deploymentTx ? (
                        <Explorer hash={safe.deploymentTx} />
                      ) : (
                        safe.saltNonce && (
                          <button
                            className="safe-button"
                            onClick={() =>
                              void run(
                                "Re-verifying the saved setup…",
                                async () => {
                                  setReview(
                                    await rpcRequest<SafeTxReview>(
                                      "safePrepareCreate",
                                      {
                                        name: safe.name,
                                        otherOwners: safe.owners.filter(
                                          (o) => !eq(o, context.owner)
                                        ),
                                        threshold: safe.threshold,
                                        saltNonce: safe.saltNonce,
                                      },
                                      0
                                    )
                                  );
                                }
                              )
                            }
                          >{uiText("Review deployment →")}</button>
                        )
                      )}
                    </div>
                  ) : (
                    <div className="safe-actions">
                      <button
                        className="safe-button safe-primary"
                        onClick={() => {
                          setCompose((v) => !v);
                          setSelectedHash("");
                        }}
                      >{uiText("＋ New transfer")}</button>
                      <button
                        className="safe-button safe-secondary"
                        onClick={() => proposalFile.current?.click()}
                      >{uiText("Import proposal")}</button>
                    </div>
                  )}
                </div>
                {compose && !pending && (
                  <form
                    className="safe-panel"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(
                        "Verifying the transfer and Safe nonce…",
                        async () => {
                          const p = await rpcRequest<SafeProposal>(
                            "safePropose",
                            { safe: safe.address, asset, recipient, amount },
                            0
                          );
                          await load();
                          setSelectedHash(p.hash);
                          setCompose(false);
                        }
                      );
                    }}
                  >
                    <span className="safe-caption">{uiText("PROPOSE A TRANSACTION")}</span>
                    <h2>{uiText("Send from your Safe")}</h2>
                    <div className="safe-input-row">
                      <label>{uiText("Asset")}<select
                          value={asset}
                          disabled={!!assetOnly}
                          onChange={(e) =>
                            setAsset(e.target.value as "ETH" | "USDC")
                          }
                        >
                          <option value="ETH">{uiText("ETH · Base")}</option>
                          <option value="USDC">{uiText("USDC · Base native")}</option>
                        </select>
                      </label>
                      <label>{uiText("Amount")}<input
                          value={amount}
                          required
                          inputMode="decimal"
                          placeholder="0.00"
                          onChange={(e) => setAmount(e.target.value)}
                        />
                      </label>
                    </div>
                    <label>{uiText("Recipient address")}<input
                        value={recipient}
                        required
                        spellCheck={false}
                        placeholder="0x…"
                        onChange={(e) => setRecipient(e.target.value)}
                      />
                    </label>
                    <p className="safe-muted">{uiText("Creating a proposal does not move funds.")}{" "}{safe.threshold}{" "}{uiText("owners must approve it before execution.")}</p>
                    <button type="submit" className="safe-button safe-primary">{uiText("Review proposal →")}</button>
                  </form>
                )}
                {proposal && (
                  <div className="safe-panel">
                    <span className="safe-caption">{uiText("OWNER APPROVAL · SAFE NONCE")}{" "}{proposal.transaction.nonce}
                    </span>
                    <h2>{uiText("Review transfer")}</h2>
                    <div className="safe-transfer-review">
                      <strong>
                        {transfer(proposal).amount}{" "}
                        <span>{transfer(proposal).asset}</span>
                      </strong>
                      <span className="safe-caption">TO</span>
                      <Address value={transfer(proposal).recipient} />
                      <TransferIdentity value={transfer(proposal)} />
                    </div>
                    <dl className="safe-facts">
                      <div>
                        <dt>{uiText("Safe")}</dt>
                        <dd>
                          <Address value={proposal.safe} />
                        </dd>
                      </div>
                      <div>
                        <dt>{uiText("Transaction hash")}</dt>
                        <dd>
                          <code>{proposal.hash}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>{uiText("Approvals")}</dt>
                        <dd>
                          {Object.keys(proposal.signatures).length}{" "}{uiText("of")}{" "}
                          {safe.threshold}
                        </dd>
                      </div>
                    </dl>
                    <div className="safe-owner-list">
                      {safe.owners.map((o) => (
                        <div key={o}>
                          <span
                            className={
                              Object.keys(proposal.signatures).some((a) =>
                                eq(a, o)
                              )
                                ? "safe-approved"
                                : ""
                            }
                          >
                            {Object.keys(proposal.signatures).some((a) =>
                              eq(a, o)
                            )
                              ? "✓"
                              : "○"}
                          </span>
                          <Address value={o} />
                          <small>
                            {Object.keys(proposal.signatures).some((a) =>
                              eq(a, o)
                            )
                              ? uiText("Approved")
                              : uiText("Waiting")}
                          </small>
                        </div>
                      ))}
                    </div>
                    {!context.nestedClearSign && (
                      <div className="safe-alert safe-warning">{uiText("This KeepKey firmware does not support the new nested Safe ClearSign display. Hardware descriptions may be limited. Rich verified descriptions also require signed metadata for this exact Safe.")}</div>
                    )}
                    {proposal.transaction.nonce !== safe.nonce ? (
                      <div className="safe-alert safe-warning">{uiText("This proposal uses an old Safe nonce. Create a fresh proposal.")}</div>
                    ) : proposal.executionTx ? (
                      <div className="safe-alert">{uiText("Execution submitted. Refresh the account to check its nonce.")}<Explorer hash={proposal.executionTx} />
                      </div>
                    ) : (
                      <div className="safe-actions">
                        {isOwner &&
                          !Object.keys(proposal.signatures).some((o) =>
                            eq(o, context.owner)
                          ) && (
                            <button
                              className="safe-button safe-primary"
                              onClick={approve}
                            >{uiText("Approve with KeepKey")}</button>
                          )}
                        <button
                          className="safe-button safe-secondary"
                          onClick={() => exportProposal(proposal)}
                        >{uiText("Export proposal")}</button>
                        <button
                          className="safe-button safe-secondary"
                          onClick={() => proposalFile.current?.click()}
                        >{uiText("Import approvals")}</button>
                        {Object.keys(proposal.signatures).length >=
                          safe.threshold && (
                          <button
                            className="safe-button safe-primary"
                            onClick={() =>
                              void run(
                                "Simulating Safe execution…",
                                async () => {
                                  setReview(
                                    await rpcRequest<SafeTxReview>(
                                      "safePrepareExecute",
                                      { hash: proposal.hash },
                                      0
                                    )
                                  );
                                }
                              )
                            }
                          >{uiText("Review execution →")}</button>
                        )}
                      </div>
                    )}
                    <p className="safe-muted">{uiText("Send the exported proposal to the other owner. They can import this Safe, verify the proposal, add their signature, and return the exported file.")}</p>
                  </div>
                )}
                <div className="safe-panel">
                  <div className="safe-panel-header">
                    <h3>{uiText("Local proposals")}</h3>
                    <span className="safe-caption">
                      {proposals.length} TOTAL
                    </span>
                  </div>
                  {!proposals.length ? (
                    <p className="safe-muted">{uiText("No proposals yet. Start a transfer or import one from another owner.")}</p>
                  ) : (
                    proposals.map((p) => (
                      <button
                        key={p.hash}
                        className={`safe-proposal ${
                          selectedHash === p.hash ? "active" : ""
                        }`}
                        onClick={() => {
                          setSelectedHash(p.hash);
                          setCompose(false);
                        }}
                      >
                        <span className="safe-number">
                          #{p.transaction.nonce}
                        </span>
                        <span>
                          <strong>
                            {transfer(p).amount} {transfer(p).asset}
                          </strong>
                          <small>{uiText("To")}{" "}{short(transfer(p).recipient)}</small>
                        </span>
                        <span className="safe-tag">
                          {p.executionTx
                            ? uiText("Submitted")
                            : p.transaction.nonce !== safe.nonce
                            ? uiText("Past nonce")
                            : `${Object.keys(p.signatures).length} / ${
                                safe.threshold
                              } approvals`}
                        </span>
                        <span>→</span>
                      </button>
                    ))
                  )}
                </div>
                <div className="safe-panel">
                  <div className="safe-panel-header">
                    <h3>{uiText("Vault identity & cosigners")}</h3>
                    <VaultIdentityBadge
                      vault={safeVaultIdentity(safe, context.sessionOnly)}
                    />
                  </div>
                  <VaultIdentityDetails
                    vault={safeVaultIdentity(safe, context.sessionOnly)}
                  />
                </div>
              </>
            )}
          </main>
        </fieldset>
      )}
    </section>
  );
}
