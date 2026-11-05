import { useUiTranslation } from "../i18n/ui";
import { useEffect, useId, useRef, useState } from "react";
import { rpcRequest } from "../lib/rpc";
import { MULTISIG_POLICY_EVENT } from "../../shared/multisig-policy";
import {
  safeVaultIdentity,
  type VaultIdentity,
} from "../../shared/vault-identity";
import type { VaultAddReview } from "../../shared/safe-multisig";
import { VaultIdentityBadge, VaultIdentityDetails } from "./VaultIdentityBadge";
import { VaultDialog } from "./VaultDialog";

export function AddVaultDialog({
  bitcoinOnly,
  onClose,
  onAdded,
}: {
  bitcoinOnly: boolean;
  onClose: () => void;
  onAdded: (vault: VaultIdentity) => void;
}) {
  const uiText = useUiTranslation();
  const formId = useId();
  const [network, setNetwork] = useState(bitcoinOnly ? "bitcoin" : "base");
  const [address, setAddress] = useState("");
  const [name, setName] = useState("Shared vault");
  const [rpcUrl, setRpcUrl] = useState("https://mainnet.base.org");
  const [review, setReview] = useState<VaultAddReview>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const run = async (status: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(status);
    setError("");
    try {
      await operation();
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (live.current) setBusy("");
    }
  };
  const inspect = () =>
    run(uiText("Verifying the Safe on Base…"), async () => {
      const result = await rpcRequest<VaultAddReview>(
        "vaultAddPreview",
        { chainId: 8453, address, name, rpcUrl },
        0
      );
      if (live.current) setReview(result);
    });
  const confirm = () =>
    run(uiText("Rechecking the reviewed owners and saving…"), async () => {
      if (!review) return;
      const vault = await rpcRequest<VaultIdentity>(
        "vaultAddConfirm",
        { reviewId: review.id },
        0
      );
      if (live.current) onAdded(vault);
    });
  const footer = review ? (
    <>
      <button
        disabled={!!busy}
        onClick={() => {
          setReview(undefined);
          setError("");
        }}
      >
        {uiText("Back")}
      </button>
      <button
        className="vault-add-primary"
        disabled={!!busy}
        onClick={() => void confirm()}
      >
        {uiText("Confirm owners & add vault")}
      </button>
    </>
  ) : (
    <>
      <button disabled={!!busy} type="button" onClick={onClose}>
        {uiText("Cancel")}
      </button>
      {network === "base" ? (
        <button
          className="vault-add-primary"
          disabled={!!busy}
          type="submit"
          form={formId}
        >
          {uiText("Verify & review vault →")}
        </button>
      ) : (
        <button
          type="button"
          className="vault-add-primary"
          onClick={() => {
            onClose();
            window.dispatchEvent(new CustomEvent(MULTISIG_POLICY_EVENT));
          }}
        >
          {uiText("Import Bitcoin policy →")}
        </button>
      )}
    </>
  );
  return (
    <VaultDialog
      title={review ? uiText("Review vault identity") : uiText("Add a vault")}
      onClose={onClose}
      busy={!!busy}
      resetKey={review?.id}
      footer={footer}
    >
      {error && (
        <div className="vault-add-error" role="alert">
          {error}
        </div>
      )}
      {busy && (
        <div className="vault-add-status" role="status">
          {busy}
        </div>
      )}
      {review ? (
        <>
          <VaultIdentityBadge
            vault={safeVaultIdentity(review.account, review.sessionOnly)}
          />
          <h3>{review.account.name}</h3>
          <p>{uiText("SafeL2 v")}{review.account.safeVersion} · {review.account.threshold}{" "}
            {uiText("of")} {review.account.owners.length} {uiText("owners")}
          </p>
          <p>
            {uiText(
              "Check the full contract address, every owner and the approval threshold before saving."
            )}
          </p>
          <VaultIdentityDetails
            vault={safeVaultIdentity(review.account, review.sessionOnly)}
            compact
            showCertification={false}
          />
          <p className="vault-add-muted">
            {uiText("Verified on Base using")} {review.rpcHost}
            {uiText(
              ". The configuration is checked again when you save. This review expires after five minutes."
            )}
          </p>
          {review.sessionOnly && (
            <p className="vault-add-warning">
              {uiText(
                "Hidden wallet: this vault will be kept in memory for this session."
              )}
            </p>
          )}
        </>
      ) : (
        <form
          id={formId}
          onSubmit={(e) => {
            e.preventDefault();
            void inspect();
          }}
        >
          <p>
            {uiText(
              "Add an existing shared account to the wallet-select page and address book."
            )}
          </p>
          <fieldset disabled={!!busy}>
            <label>
              {uiText("Vault type & network")}
              <select
                value={network}
                onChange={(e) => {
                  setNetwork(e.target.value);
                  setError("");
                }}
              >
                <option value="base" disabled={bitcoinOnly}>
                  {uiText("Safe · Base mainnet · chain 8453")}
                </option>
                <option value="bitcoin">
                  {uiText("Bitcoin multisig · Bitcoin mainnet")}
                </option>
              </select>
            </label>
            {network === "base" ? (
              <>
                <div className="vault-add-network">
                  <span className="vault-add-base-dot" />
                  {uiText("Base only")} <code>{uiText("eip155:8453")}</code>
                </div>
                <label>
                  {uiText("Safe contract address")}
                  <input
                    required
                    value={address}
                    placeholder="0x…"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => {
                      setAddress(e.target.value);
                      setError("");
                    }}
                  />
                </label>
                <label>
                  {uiText("Vault name")}
                  <input
                    required
                    value={name}
                    maxLength={60}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <details>
                  <summary>{uiText("Verification RPC")}</summary>
                  <label>
                    {uiText("Base RPC URL")}
                    <input
                      required
                      type="url"
                      value={rpcUrl}
                      spellCheck={false}
                      onChange={(e) => setRpcUrl(e.target.value)}
                    />
                  </label>
                </details>
                <p className="vault-add-muted">
                  {uiText(
                    "Supports verified SafeL2 v1.4.1 and v1.5.0 contracts on Base. Use the Safe contract address. An owner’s personal address cannot be imported as a vault."
                  )}
                </p>
              </>
            ) : (
              <>
                <p className="vault-add-muted">
                  {uiText(
                    "Import the Bitcoin vault’s descriptor or coordinator policy and verify its cosigners on a connected KeepKey."
                  )}
                </p>
                <code className="vault-add-network">{uiText("bip122:000000000019d6689c085ae165831e93")}</code>
              </>
            )}
          </fieldset>
        </form>
      )}
    </VaultDialog>
  );
}
