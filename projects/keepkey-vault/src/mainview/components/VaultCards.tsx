import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { useUiTranslation } from "../i18n/ui";
import { onRpcMessage, rpcRequest } from "../lib/rpc";
import { MULTISIG_ENROLLED_EVENT } from "../../shared/multisig-policy";
import type { VaultIdentity } from "../../shared/vault-identity";
import type { VaultPortfolio } from "../../shared/vault-portfolio";
import type { RegisteredDevice } from "../../shared/types";
import { vaultLinkColor } from "../../shared/vault-wallet-links";
import { VaultIdentityBadge, VaultIdentityDetails } from "./VaultIdentityBadge";
import { WalletTile, WalletTileCta } from "./WalletTile";
import { VaultDialog } from "./VaultDialog";
import "./VaultCards.css";

export function useSavedVaults(bitcoinOnly: boolean) {
  const [saved, setSaved] = useState<VaultIdentity[]>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    let active = true;
    const load = () => {
      const gen = ++generation.current;
      void rpcRequest<VaultIdentity[]>("listSavedVaults", undefined, 0)
        .then((v) => {
          if (active && gen === generation.current) {
            setSaved(v);
            setError("");
          }
        })
        .catch((e) => {
          if (active && gen === generation.current) setError(e.message);
        });
    };
    load();
    const off = onRpcMessage("vaults-changed", load);
    const purge = onRpcMessage("wallet-data-purged", () => {
      setSaved([]);
      load();
    });
    window.addEventListener(MULTISIG_ENROLLED_EVENT, load);
    return () => {
      active = false;
      generation.current++;
      off();
      purge();
      window.removeEventListener(MULTISIG_ENROLLED_EVENT, load);
    };
  }, [revision, bitcoinOnly]);
  return {
    vaults: saved.filter((v) => !bitcoinOnly || v.type === "bitcoin-multisig"),
    error,
    reload,
  };
}

/** Color is paired with a name; it never substitutes for chain/account identity. */
export function VaultLinkChips({
  vaults,
  onOpen,
}: {
  vaults: VaultIdentity[];
  onOpen: (id: string) => void;
}) {
  const uiText = useUiTranslation();
  if (!vaults.length) return null;
  return (
    <div className="vault-wallet-links" aria-label={uiText("Linked vaults")}>
      {vaults.map((v) => (
        <button
          key={v.id}
          className="vault-link-chip"
          style={
            { "--vault-link": vaultLinkColor(v.id) } as React.CSSProperties
          }
          title={`${uiText("Cosigner of")} ${v.name} · ${v.networkId} · ${
            v.address
          }`}
          onClick={() => onOpen(v.id)}
        >
          <span className="vault-link-dot" />
          {v.name}
        </button>
      ))}
    </div>
  );
}

export function VaultTile({
  vault,
  devices,
  onOpen,
  portfolio,
  showValues = true,
  onToggleTotal,
}: {
  vault: VaultIdentity;
  devices: RegisteredDevice[];
  onOpen: () => void;
  portfolio?: VaultPortfolio;
  showValues?: boolean;
  onToggleTotal?: (include: boolean) => Promise<void>;
}) {
  const uiText = useUiTranslation();
  const color = vaultLinkColor(vault.id);
  const [saving, setSaving] = useState(false);
  const [toggleError, setToggleError] = useState('');
  return (
    <WalletTile>
      <Flex justify="space-between" align="center" mb="2">
        <span
          className="vault-tile-badge"
          style={{ "--vault-link": color } as React.CSSProperties}
        >
          <span className="vault-link-dot" />
          {uiText("Vault")}
        </span>
        <Text fontSize="10px" color="var(--text-2)">
          {vault.threshold} {uiText("of")} {vault.cosigners.length}
        </Text>
      </Flex>
      <Flex align="center" gap="2.5" mb="2.5">
        <Box className="vault-tile-icon" style={{ color }}>
          <svg
            width="23"
            height="23"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="3"
              y="3"
              width="18"
              height="18"
              rx="3"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <circle
              cx="12"
              cy="12"
              r="4"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M12 6v3m0 6v3m-6-6h3m6 0h3"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <circle cx="12" cy="12" r="1" fill="currentColor" />
          </svg>
        </Box>
        <Box flex="1" minW="0">
          <Text
            fontSize="14px"
            fontWeight="500"
            color="var(--text-0)"
            truncate
            lineHeight="1.2"
            title={vault.name}
          >
            {vault.name}
          </Text>
          <Text fontSize="10px" color="var(--text-3)" mt="1">
            {vault.supportedAssets.map((a) => a.symbol).join(" / ")} ·{" "}
            {uiText("Shared account")}
          </Text>
        </Box>
      </Flex>
      <div className="vault-tile-network">
        <VaultIdentityBadge vault={vault} />
      </div>
      <code
        className="vault-tile-address"
        title={`${vault.networkId} · ${vault.address}`}
      >
        {vault.address.slice(0, 10)}…{vault.address.slice(-8)}
      </code>
      <div className="vault-tile-balance">
        <span>{uiText("BALANCE")}</span>
        <strong>{!showValues ? '$ ••••' : portfolio?.totalUsd === undefined ? '—'
          : new Intl.NumberFormat(undefined, {style: 'currency', currency: 'USD', maximumFractionDigits: 2}).format(portfolio.totalUsd)}</strong>
      </div>
      {onToggleTotal && <label className="vault-total-toggle">
        <input type="checkbox" checked={portfolio?.includeInTotal ?? true} disabled={saving}
          onChange={async e => { setSaving(true); setToggleError(''); try { await onToggleTotal(e.target.checked) } catch (err) { setToggleError(err instanceof Error ? err.message : String(err)) } finally { setSaving(false) } }} />
        {uiText("Include in total")}
      </label>}
      {toggleError && <p className="vault-tile-warning" role="alert">{toggleError}</p>}
      {!vault.receiveEnabled && (
        <p className="vault-tile-warning">
          {vault.fundingBlockedReason || uiText("Review required")}
        </p>
      )}
      <div
        className="vault-tile-cosigners"
        aria-label={uiText("Cosigner wallets")}
      >
        {devices.length ? (
          devices.map((d) => (
            <span
              key={d.deviceId}
              className="vault-link-chip"
              style={{ "--vault-link": color } as React.CSSProperties}
              title={uiText("Matched cached cosigner key")}
            >
              <span className="vault-link-dot" />
              {d.label || uiText("KeepKey")}
            </span>
          ))
        ) : (
          <span className="vault-tile-muted">
            {uiText("Saved owner configuration")}
          </span>
        )}
      </div>
      <WalletTileCta onClick={onOpen}>{uiText("Open vault")}</WalletTileCta>
    </WalletTile>
  );
}

export function VaultIdentityDialog({
  vault,
  onClose,
}: {
  vault: VaultIdentity;
  onClose: () => void;
}) {
  const uiText = useUiTranslation();
  return (
    <VaultDialog
      title={vault.name}
      onClose={onClose}
      footer={
        <button className="vault-add-primary" onClick={onClose}>
          {uiText("Done")}
        </button>
      }
    >
      <VaultIdentityBadge vault={vault} />
      <p>
        {vault.type === "safe"
          ? `SafeL2 v${vault.safeVersion || "1.4.1"}`
          : uiText("Bitcoin multisig")}{" "}
        · {vault.threshold} {uiText("of")} {vault.cosigners.length}{" "}
        {uiText("approvals required")}
      </p>
      <VaultIdentityDetails vault={vault} compact />
      <p className="vault-add-muted">
        {uiText(
          "Saved snapshot · connect an owner KeepKey to manage this vault."
        )}
      </p>
    </VaultDialog>
  );
}
