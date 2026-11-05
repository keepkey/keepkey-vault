import { useUiTranslation } from "../i18n/ui";
import type { VaultIdentity } from "../../shared/vault-identity";

export function VaultIdentityBadge({ vault }: { vault: VaultIdentity }) {
  const uiText = useUiTranslation();

  const bitcoin = vault.type === "bitcoin-multisig";
  return (
    <span
      title={vault.networkId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: bitcoin ? "#f3a845" : "#8eafff",
        fontSize: 10,
        whiteSpace: "nowrap",
      }}
    >
      <svg
        width="22"
        height="24"
        viewBox="0 0 24 26"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M12 1 2 5v8c0 5 5 9 10 12 5-3 10-7 10-12V5z"
          stroke="currentColor"
          fill="currentColor"
          fillOpacity=".08"
        />
        {bitcoin ? (
          <text
            x="12"
            y="18"
            textAnchor="middle"
            fill="currentColor"
            fontSize="18"
          >
            ₿
          </text>
        ) : (
          <>
            <circle cx="12" cy="12" r="6" fill="#0052ff" />
            <path d="M7 12h10" stroke="white" strokeWidth="1.5" />
          </>
        )}
      </svg>
      {bitcoin ? uiText("Bitcoin only") : uiText("Base only · 8453")}
    </span>
  );
}

export function VaultIdentityDetails({
  vault,
  compact = false,
  showCertification = true,
}: {
  vault: VaultIdentity;
  compact?: boolean;
  showCertification?: boolean;
}) {
  const uiText = useUiTranslation();
  const technical = (
    <>
      <div>
        <strong>{uiText("Network (CAIP-2)")}</strong>
        <br />
        <code>{vault.networkId}</code>
      </div>
      <div>
        <strong>{uiText("Account (CAIP-10)")}</strong>
        <br />
        <code>{vault.accountId}</code>
        {vault.type === "bitcoin-multisig" && (
          <div>
            {uiText("Receive address 0 · policy")} {vault.policyId}
          </div>
        )}
      </div>
      <div>
        <strong>{uiText("Assets managed by Vault (CAIP-19)")}</strong>
        {vault.supportedAssets.map((a) => (
          <div key={a.caip}>
            <b>{a.symbol}</b> · {a.decimals} {uiText("decimals")}
            <br />
            <code>{a.caip}</code>
            {a.contract && (
              <div>
                {uiText("Token contract:")} <code>{a.contract}</code>
              </div>
            )}
          </div>
        ))}
      </div>
      {showCertification && vault.certificationLabel && (
        <div>
          {uiText("Label for device certification:")}{" "}
          <b>{vault.certificationLabel}</b>
          {uiText(
            ". Review this destination under Address Book → Certify contacts."
          )}
        </div>
      )}
    </>
  );
  return (
    <div
      style={{
        display: "grid",
        gap: 9,
        fontSize: 10,
        lineHeight: 1.7,
        color: "var(--text-2)",
        overflowWrap: "anywhere",
        minWidth: 0,
      }}
    >
      {compact ? (
        <div>
          <strong>{uiText("Vault address")}</strong>
          <br />
          <code style={{ color: "var(--text-0)" }}>{vault.address}</code>
          <br />
          {vault.networkId}
        </div>
      ) : (
        technical
      )}
      <div>
        <strong>
          {uiText("Cosigners ·")} {vault.threshold} {uiText("of")}{" "}
          {vault.cosigners.length} {uiText("required")}
        </strong>
        {vault.cosigners.map((c, i) => (
          <div
            key={c.address || c.xpub || i}
            style={{
              borderTop: "1px solid var(--line)",
              paddingTop: 7,
              marginTop: 7,
            }}
          >
            <span>{String(i + 1).padStart(2, "0")} · </span>
            {c.address ? (
              <code>{c.address}</code>
            ) : (
              <>
                <code>
                  {c.fingerprint} · {c.path}
                </code>
                <br />
                <code>{c.xpub}</code>
              </>
            )}
          </div>
        ))}
      </div>
      {vault.type === "safe" && (
        <div>
          {uiText(
            "Owner configuration is the snapshot from the last on-chain refresh. Destination certification does not certify these owners or the threshold."
          )}
        </div>
      )}
      {compact && (
        <details className="vault-identity-technical">
          <summary>{uiText("Network & asset details")}</summary>
          <div style={{ display: "grid", gap: 9 }}>{technical}</div>
        </details>
      )}
    </div>
  );
}
