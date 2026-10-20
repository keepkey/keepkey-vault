import { useBtcMultisigEnabled } from "../hooks/useBtcMultisigEnabled";
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, Flex, Text, Textarea } from "@chakra-ui/react";
import {
  MULTISIG_ENROLLED_EVENT,
  MULTISIG_POLICY_EVENT,
  type MultisigCosignerExport,
  type MultisigPolicyPreview,
} from "../../shared/multisig-policy";
import { rpcRequest } from "../lib/rpc";
import { Z } from "../lib/z-index";
import { BitcoinQrDialog } from "./BitcoinQrDialog";

const MAX = 1024 * 1024;
const outline = {
  size: "sm",
  variant: "outline",
  borderColor: "kk.border",
  color: "kk.textPrimary",
} as const;
const mono = {
  fontFamily: "mono",
  fontSize: "xs",
  wordBreak: "break-all",
} as const;

/** Only public policies are imported. Every policy is matched to the actual
 * KeepKey account key, then its first receive address is displayed on device. */
export function MultisigPolicyDialog() {
  const enabled = useBtcMultisigEnabled();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState("");
  const [name, setName] = useState("Multisig");
  const [preview, setPreview] = useState<MultisigPolicyPreview | null>(null);
  const [saved, setSaved] = useState<MultisigPolicyPreview[]>([]);
  const [key, setKey] = useState<MultisigCosignerExport | null>(null);
  const [scriptType, setScriptType] = useState("p2wsh");
  const [account, setAccount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const locked = useRef(false);
  const generation = useRef(0);
  const refresh = useCallback(
    async () =>
      setSaved(
        await rpcRequest<MultisigPolicyPreview[]>("btcMultisigPolicies")
      ),
    []
  );
  const readFile = async (file: File) => {
    if (file.size > MAX) throw new Error("Policy exceeds 1 MB");
    const text = await file.text();
    setData(text);
    setPreview(null);
  };
  useEffect(() => {
    const onOpen = async (event: Event) => {
      if (locked.current) return;
      const rev = ++generation.current;
      setOpen(true);
      setError("");
      setNotice("");
      setPreview(null);
      setKey(null);
      setData("");
      setQr(null);
      if (!enabled) return;
      try {
        const file = (event as CustomEvent<File>).detail;
        if (file instanceof File) await readFile(file);
        const records = await rpcRequest<MultisigPolicyPreview[]>(
          "btcMultisigPolicies"
        );
        if (rev === generation.current) setSaved(records);
      } catch (e: any) {
        if (rev === generation.current) setError(e.message);
      }
    };
    window.addEventListener(MULTISIG_POLICY_EVENT, onOpen);
    return () => window.removeEventListener(MULTISIG_POLICY_EVENT, onOpen);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) {
      ++generation.current;
      setPreview(null);
      setKey(null);
      setSaved([]);
      setQr(null);
      setData("");
    }
  }, [enabled]);
  const run = async (operation: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (e: any) {
      setError(e.message || "Operation failed");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const close = () => {
    if (!locked.current) {
      ++generation.current;
      setOpen(false);
      setQr(null);
    }
  };
  const download = (policy: MultisigPolicyPreview) => {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              format: "keepkey-multisig-policy",
              version: 1,
              descriptor: policy.descriptor,
            },
            null,
            2
          ),
        ],
        { type: "application/json" }
      )
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "multisig-public-policy.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (!open) return null;
  if (!enabled)
    return (
      <>
        <Box
          position="fixed"
          inset="0"
          bg="rgba(0,0,0,0.85)"
          zIndex={Z.dialog + 2}
          onClick={close}
        />
        <Box
          role="dialog"
          aria-label="Multisig co-signing disabled"
          position="fixed"
          top="50%"
          left="50%"
          transform="translate(-50%,-50%)"
          zIndex={Z.dialog + 3}
          bg="kk.bg"
          borderRadius="xl"
          p="6"
          maxW="90vw"
        >
          <Text>
            Bitcoin multisig co-signing is off. Enable it in Settings → Feature
            Flags.
          </Text>
          <Button {...outline} mt="4" onClick={close}>
            Close
          </Button>
        </Box>
      </>
    );

  return (
    <>
      {qr && (
        <BitcoinQrDialog
          bytes={new TextEncoder().encode(qr)}
          title="Public multisig policy QR"
          onClose={() => setQr(null)}
        />
      )}
      <Box
        position="fixed"
        inset="0"
        bg="rgba(0,0,0,0.85)"
        zIndex={Z.dialog + 2}
        onClick={close}
      />
      <Box
        position="fixed"
        top="50%"
        left="50%"
        transform="translate(-50%, -50%)"
        w="640px"
        maxW="94vw"
        maxH="90vh"
        overflowY="auto"
        bg="kk.bg"
        border="1px solid"
        borderColor="kk.border"
        borderRadius="xl"
        zIndex={Z.dialog + 3}
        p="6"
        role="dialog"
        aria-modal="true"
        aria-label="Multisig co-signing"
      >
        <Text fontWeight="700" fontSize="lg">
          Multisig co-signing
        </Text>
        <Text fontSize="sm" color="kk.textSecondary" my="3">
          Set up the wallet in Sparrow or Electrum. Desktop adds this KeepKey’s
          signature and returns a PSBT to the coordinator. Public keys reveal
          wallet activity; never import recovery words or private keys.
        </Text>
        <Text fontSize="sm" fontWeight="600" mb="2">
          1. Export this KeepKey’s public cosigner key
        </Text>
        <Flex gap="2" wrap="wrap" mb="2">
          <select
            aria-label="Multisig script type"
            disabled={busy}
            value={scriptType}
            onChange={(e) => {
              setScriptType(e.target.value);
              setKey(null);
            }}
            style={{ background: "#202020", color: "white" }}
          >
            <option value="p2wsh">Native SegWit (P2WSH)</option>
            <option value="p2sh-p2wsh">Wrapped SegWit</option>
            <option value="p2sh">Legacy (P2SH)</option>
          </select>
          <label>
            Account{" "}
            <input
              aria-label="Multisig account"
              disabled={busy}
              type="number"
              min="0"
              max="100"
              value={account}
              onChange={(e) => {
                setAccount(Number(e.target.value));
                setKey(null);
              }}
              style={{ width: 65, background: "#202020", color: "white" }}
            />
          </label>
          <Button
            {...outline}
            disabled={busy}
            onClick={() =>
              void run(async () =>
                setKey(
                  await rpcRequest<MultisigCosignerExport>(
                    "btcMultisigCosigner",
                    { scriptType, accountIndex: account },
                    60000
                  )
                )
              )
            }
          >
            Read public key
          </Button>
        </Flex>
        {key && (
          <Box mb="4">
            <Text {...mono}>{key.key}</Text>
            <Text fontSize="xs">
              Mainnet · {key.derivation} · fingerprint {key.fingerprint}
            </Text>
            <Button
              {...outline}
              mt="2"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await navigator.clipboard.writeText(key.key);
                  setNotice("Public cosigner key copied");
                })
              }
            >
              Copy key with origin
            </Button>
          </Box>
        )}
        <Text fontSize="sm" fontWeight="600" mt="4" mb="2">
          2. Import the complete public wallet policy
        </Text>
        <Text fontSize="xs" color="kk.textSecondary" mb="2">
          Paste Sparrow’s output descriptor or load an unencrypted public
          Electrum multisig wallet. Every cosigner needs a master fingerprint
          and derivation path. Receive and change branches are derived locally.
        </Text>
        <Textarea
          disabled={busy}
          rows={5}
          fontFamily="mono"
          fontSize="xs"
          value={data}
          onChange={(e) => {
            setData(e.target.value);
            setPreview(null);
          }}
          placeholder="wsh(sortedmulti(2,[fingerprint/48h/0h/0h/2h]xpub…/<0;1>/*,…))"
        />
        <Flex gap="2" wrap="wrap" my="3">
          <input
            aria-label="Public multisig policy file"
            type="file"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void run(() => readFile(file));
              e.target.value = "";
            }}
          />
          <Button
            {...outline}
            disabled={busy || !data.trim()}
            onClick={() =>
              void run(async () =>
                setPreview(
                  await rpcRequest<MultisigPolicyPreview>(
                    "btcMultisigPolicy",
                    { data, name },
                    60000
                  )
                )
              )
            }
          >
            Check policy
          </Button>
        </Flex>
        {preview && (
          <Box
            border="1px solid"
            borderColor="kk.border"
            p="3"
            borderRadius="lg"
          >
            <Text fontWeight="600">
              {preview.threshold} of {preview.cosigners.length} ·{" "}
              {preview.scriptType} · Bitcoin mainnet
            </Text>
            {preview.cosigners.map((c) => (
              <Box key={c.xpub} my="2">
                <Text fontSize="xs">
                  {c.fingerprint} · {c.path}
                  {c.ours ? " · This KeepKey" : ""}
                </Text>
                <Text {...mono}>{c.xpub}</Text>
              </Box>
            ))}
            <Text fontSize="xs" mt="2">
              First receive address — compare with the coordinator and KeepKey:
            </Text>
            <Text {...mono}>{preview.address}</Text>
            {preview.sessionOnly && (
              <Text fontSize="xs" color="kk.gold">
                Passphrase wallet: this policy is kept only for the current
                unlocked session. Import and verify it again after restarting.
              </Text>
            )}
            <label>
              Policy name{" "}
              <input
                disabled={busy}
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ background: "#202020", color: "white", marginTop: 8 }}
              />
            </label>
            <Button
              {...outline}
              mt="3"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setNotice(
                    "Compare and confirm the first receive address on KeepKey."
                  );
                  const policy = await rpcRequest<MultisigPolicyPreview>(
                    "btcMultisigPolicy",
                    { data, name, save: true },
                    0
                  );
                  setPreview(policy);
                  await refresh();
                  setNotice(
                    policy.sessionOnly
                      ? "Policy verified for this session."
                      : "Policy verified and saved for future sessions."
                  );
                  window.dispatchEvent(new Event(MULTISIG_ENROLLED_EVENT));
                })
              }
            >
              Verify address on KeepKey and save
            </Button>
          </Box>
        )}
        {saved.length > 0 && (
          <Box mt="4">
            <Text fontSize="sm" fontWeight="600">
              Verified policies
            </Text>
            {saved.map((p) => (
              <Box
                key={p.id}
                borderBottom="1px solid"
                borderColor="kk.border"
                py="3"
              >
                <Text fontSize="sm">
                  {p.name} · {p.threshold} of {p.cosigners.length} ·{" "}
                  {p.scriptType}
                  {p.sessionOnly ? " · Session only" : ""}
                </Text>
                <Text fontSize="xs">
                  Enrolled key:{" "}
                  {p.cosigners
                    .filter((c) => c.ours)
                    .map((c) => c.fingerprint)
                    .join(", ")}
                </Text>
                <Flex gap="2" wrap="wrap" mt="2">
                  <Button
                    {...outline}
                    disabled={busy}
                    onClick={() => {
                      setData(p.descriptor);
                      setName(p.name);
                      setPreview(null);
                    }}
                  >
                    Load policy
                  </Button>
                  <Button
                    {...outline}
                    disabled={busy}
                    onClick={() => download(p)}
                  >
                    Export public policy
                  </Button>
                  <Button
                    {...outline}
                    disabled={busy}
                    onClick={() => setQr(p.descriptor)}
                  >
                    Policy QR
                  </Button>
                  <Button
                    {...outline}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await rpcRequest("btcMultisigPolicyDelete", {
                          id: p.id,
                        });
                        await refresh();
                        setPreview(null);
                      })
                    }
                  >
                    Remove
                  </Button>
                </Flex>
              </Box>
            ))}
          </Box>
        )}
        {notice && (
          <Text fontSize="sm" color="kk.gold" mt="3">
            {notice}
          </Text>
        )}
        {error && (
          <Text role="alert" fontSize="sm" color="var(--rose)" mt="3">
            {error}
          </Text>
        )}
        <Flex justify="flex-end" mt="4">
          <Button {...outline} disabled={busy} onClick={close}>
            {busy ? "Waiting for KeepKey…" : "Close"}
          </Button>
        </Flex>
      </Box>
    </>
  );
}
