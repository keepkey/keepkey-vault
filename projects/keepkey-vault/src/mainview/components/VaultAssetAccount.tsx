import { useUiTranslation } from "../i18n/ui"
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { VaultAssetAccount as AccountState } from "../../shared/vault-asset-account";
import {
  vaultAssetReceiveUri,
  assertVaultAssetResponse,
} from "../../shared/vault-asset-account";
import {
  BASE_USDC_CAIP,
  type VaultIdentity,
} from "../../shared/vault-identity";
import { rpcRequest, onRpcMessage } from "../lib/rpc";
import { useFiat } from "../lib/fiat-context";
import { generateQRSvg } from "../lib/qr";
import { PSBT_PASTE_EVENT } from "./PsbtSignDialog";
import { VaultIdentityBadge, VaultIdentityDetails } from "./VaultIdentityBadge";
import { SafeMultisigView } from "./SafeMultisigView";
import { AssetIcon } from './AssetIcon';
import "./VaultAssetAccount.css";
import './VaultWallet.css';

export function VaultAssetAccount({
  vault,
  assetCaip,
  networkId,
  action,
  watchOnly,
  selector,
  onAction,
  onAsset,
  onBack,
  onBusy,
}: {
  vault: VaultIdentity;
  assetCaip: string;
  networkId: string;
  action: "receive" | "send";
  watchOnly?: boolean;
  selector: ReactNode;
  onAction: (action: "receive" | "send") => void;
  onAsset: (caip: string) => void;
  onBack: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const uiText = useUiTranslation()
  const { privateModeEnabled } = useFiat()

  const key = JSON.stringify([vault.id, networkId, assetCaip]);
  const [loaded, setLoaded] = useState<{ key: string; value: AccountState }>();
  const [opened, setOpened] = useState("");
  const [busy, setBusy] = useState("");
  const [signingBusy, setSigningBusy] = useState(false);
  const locked = !!busy || signingBusy;
  const [error, setError] = useState("");
  const [rpcUrl, setRpcUrl] = useState("https://mainnet.base.org");
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const request = { vaultId: vault.id, networkId, assetCaip };
  const value = loaded?.key === key ? loaded.value : undefined;
  const identity = value?.identity || vault;
  const asset = identity.supportedAssets.find(
    (a) => a.caip.toLowerCase() === assetCaip.toLowerCase()
  );
  const balance = value?.safe
    ? assetCaip.toLowerCase() === BASE_USDC_CAIP.toLowerCase()
      ? value.safe.balanceUsdc
      : value.safe.balanceEth
    : undefined;
  useEffect(() => {
    let active = true;
    const gen = ++generation.current;
    setError("");
    setOpened("");
    setLoaded(undefined);
    setBusy("Verifying vault account…");
    void rpcRequest<AccountState>("vaultAccountGet", request, 0)
      .then((result) => {
        assertVaultAssetResponse(request, vault, result);
        if (active && gen === generation.current) {
          setLoaded({ key, value: result });
          setError("");
        }
      })
      .catch((e) => {
        if (active && gen === generation.current) setError(e.message);
      })
      .finally(() => {
        if (active && gen === generation.current) setBusy("");
      });
    const off = onRpcMessage("wallet-data-purged", () => {
      generation.current++;
      setLoaded(undefined);
      setOpened("");
      setBusy("");
      setError(
        "Wallet changed. Re-verify this vault account before continuing."
      );
    });
    return () => {
      active = false;
      generation.current++;
      off();
    };
  }, [key, retry]);
  useEffect(() => {
    onBusy(locked);
    return () => onBusy(false);
  }, [locked, onBusy]);
  const openSend = async () => {
    if (!value || watchOnly || locked) return;
    const gen = generation.current;
    setBusy("Binding this Safe to the connected signing session…");
    setError("");
    try {
      await rpcRequest("safeOpenVaultAccount", request, 0);
      if (gen === generation.current) setOpened(key);
    } catch (e) {
      if (gen === generation.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === generation.current) setBusy("");
    }
  };
  const configure = async () => {
    if (locked) return;
    setBusy("Verifying Base RPC…");
    setError("");
    try {
      await rpcRequest(
        "setEvmSimulationRpc",
        { chainId: 8453, url: rpcUrl },
        0
      );
      setRetry((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  let uri = "";
  if (value && asset) uri = vaultAssetReceiveUri(identity, assetCaip);
  return (
    <section className="vault-asset-page vault-wallet-scope" aria-label={uiText("Vault asset account")}>
      <header>
        <button disabled={locked} onClick={onBack}>{uiText("← Back to assets")}</button>
        <VaultIdentityBadge vault={identity} />
      </header>
      <div className="vault-asset-hero">
        <AssetIcon caip={assetCaip} size={72} alt={asset?.symbol || 'Vault'} />
        <span className="vault-asset-caption">{identity.type === 'safe' ? 'BASE' : 'BITCOIN'} · {uiText("SHARED VAULT")}</span>
        <h1>{identity.name}</h1>
        <code>{identity.address}</code>
        <div className="vault-asset-balance">
          {privateModeEnabled ? "••••" : balance === undefined ? "—" : balance}{" "}
          <span>{asset?.symbol || uiText("Unsupported asset")}</span>
        </div>
        <p>
          {value
            ? `${identity.threshold} of ${identity.cosigners.length} approvals required`
            : uiText("Verifying the selected vault…")}{" "}
          · {networkId}
        </p>
        {balance === undefined && (
          <p>{uiText("Vault balance is unverified. No personal-wallet balance is used here.")}</p>
        )}
      </div>
      {selector}
      <div className="vault-asset-toolbar">
        <div className="vault-asset-pills" role="group" aria-label={uiText('Vault asset')}>
          {identity.supportedAssets.map(a => <button key={a.caip} disabled={locked}
            aria-pressed={assetCaip.toLowerCase() === a.caip.toLowerCase()}
            onClick={() => onAsset(a.caip)}>{a.symbol}</button>)}
        </div>
        <div className="vault-action-pills">
          <button
            disabled={locked}
            aria-pressed={action === "receive"}
            onClick={() => onAction("receive")}
          >{uiText("Receive")}</button>
          {!watchOnly && (
            <button
              disabled={locked}
              aria-pressed={action === "send"}
              onClick={() => onAction("send")}
            >{uiText("Send")}</button>
          )}
        </div>
        <button disabled={locked} onClick={() => setRetry((n) => n + 1)}>{uiText("↻ Refresh vault")}</button>
      </div>
      {busy && (
        <p role="status" className="vault-asset-notice">
          {busy}
        </p>
      )}
      {error && (
        <div role="alert" className="vault-asset-error">
          {error}
          <button onClick={() => setRetry((n) => n + 1)} disabled={locked}>{uiText("Retry verification")}</button>
        </div>
      )}
      {error && identity.type === "safe" && (
        <form
          className="vault-asset-provider"
          onSubmit={(e) => {
            e.preventDefault();
            void configure();
          }}
        >
          <p>{uiText("Safe account verification needs a Base RPC provider. This updates the Base provider used for vault operations.")}</p>
          <label>{uiText("Base RPC URL")}<input
              type="url"
              required
              value={rpcUrl}
              onChange={(e) => setRpcUrl(e.target.value)}
            />
          </label>
          <button type="submit" disabled={locked}>{uiText("Verify & use Base RPC")}</button>
        </form>
      )}
      {value && asset && (action === "receive" || watchOnly) && (
        <div className="vault-asset-receive">
          <h2>{uiText("Receive")}{" "}{asset.symbol}{" "}{uiText("in this vault")}</h2>
          <div
            className="vault-asset-qr"
            role="img"
            aria-label={`${asset.symbol} receive QR for ${networkId}`}
            dangerouslySetInnerHTML={{ __html: generateQRSvg(uri, 4, 2) }}
          />
          <p>
            {identity.type === "bitcoin-multisig"
              ? uiText("Policy-derived receive address #0")
              : uiText("Safe contract address")}
          </p>
          <code>{identity.address}</code>
          <button
            onClick={() => {
              void navigator.clipboard
                .writeText(identity.address)
                .then(() => setCopied(true));
            }}
          >
            {copied ? uiText("Copied") : uiText("Copy vault address")}
          </button>
          <p className="vault-asset-caption">{uiText("CHAIN-BOUND PAYMENT REQUEST")}</p>
          <code>{uri}</code>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(uri);
            }}
          >{uiText("Copy payment request")}</button>
          <code>{asset.caip}</code>
          {asset.contract && (
            <p>{uiText("Token contract:")}{" "}<code>{asset.contract}</code>
            </p>
          )}
        </div>
      )}
      {value &&
        asset &&
        action === "send" &&
        !watchOnly &&
        (identity.type === "safe" ? (
          <>
            {opened !== key ? (
              <div className="vault-asset-send">
                <h2>{uiText("Send")}{" "}{asset.symbol}{" "}{uiText("from")}{" "}{identity.name}
                </h2>
                <p>{uiText("Source:")}{" "}<code>{identity.accountId}</code>
                </p>
                <p>{uiText("Create a Safe proposal, collect")}{" "}{identity.threshold}{" "}{uiText("owner approvals, then review execution. The connected KeepKey’s account 0 pays execution gas.")}</p>
                <button disabled={locked} onClick={() => void openSend()}>{uiText("Continue with this Safe account →")}</button>
              </div>
            ) : (
              <SafeMultisigView
                key={key}
                initialAddress={identity.address}
                embedded
                initialCompose
                assetOnly={asset.symbol as "ETH" | "USDC"}
                onBusyChange={setSigningBusy}
              />
            )}
          </>
        ) : (
          <div className="vault-asset-send">
            <h2>{uiText("Send from this Bitcoin vault")}</h2>
            <p>{uiText("Spending uses a coordinator PSBT for this exact verified policy. KeepKey reviews the transaction and adds its co-signature.")}</p>
            <code>{identity.policyId}</code>
            <button
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent(PSBT_PASTE_EVENT, {
                    detail: { vaultPolicyId: identity.policyId },
                  })
                )
              }
            >{uiText("Review / co-sign vault PSBT →")}</button>
          </div>
        ))}
      <details className="vault-asset-identity">
        <summary>{uiText("Vault identity & cosigners")}</summary>
        <VaultIdentityDetails vault={identity} />
      </details>
    </section>
  );
}
