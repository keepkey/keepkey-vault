import { useState } from "react"
import { Box, Flex, Text, Input, Button } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import type { AppSettings } from "../../shared/types"

const ACCENT = "#F7931A" // bitcoin orange

type TestResult = { ok: boolean; error?: string; chain?: string; blocks?: number; pruned?: boolean; txindex?: boolean; inSync?: boolean }

/** Self-host Bitcoin node config (btc-only). Point Vault at your own Bitcoin Core
 *  node instead of Pioneer. Verbose Test Connection; no silent fallback — if the
 *  node is enabled and fails, the app surfaces the error rather than phoning home. */
export function SelfHostNodePanel({ settings, onChange }: { settings: AppSettings; onChange: (s: AppSettings) => void }) {
  const [type, setType] = useState<"blockbook" | "core">(settings.btcNodeType || "blockbook")
  const [url, setUrl] = useState(settings.btcNodeUrl || "")
  const [auth, setAuth] = useState("")
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const enabled = settings.btcNodeEnabled

  const test = async () => {
    setTesting(true); setResult(null)
    try {
      setResult(await rpcRequest<TestResult>("testBtcNode", { type, url: url.trim(), auth: auth || undefined }, 20000))
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || "Test failed" })
    }
    setTesting(false)
  }

  const save = async (nextEnabled: boolean) => {
    setSaving(true)
    try {
      const s = await rpcRequest<AppSettings>("setBtcNode", { enabled: nextEnabled, type, url: url.trim(), auth: auth || undefined }, 10000)
      onChange(s)
    } catch (e: any) { console.error("setBtcNode:", e) }
    setSaving(false)
  }

  return (
    <Box border="1px solid" borderColor="kk.border" borderRadius="12px" p="3" bg="kk.bg">
      <Flex align="center" gap="2" mb="1">
        <Text fontSize="md" color="kk.textPrimary" fontWeight="500">Self-host node</Text>
        {enabled && <Text fontSize="9px" color="var(--teal)" bg="rgba(139,227,196,0.12)" px="1.5" py="0.5" borderRadius="sm" textTransform="uppercase" letterSpacing="0.05em">Active</Text>}
      </Flex>
      <Text fontSize="sm" color="kk.textSecondary" mb="3">
        Point Vault at your own {type === "blockbook" ? "Blockbook indexer" : "Bitcoin Core node"} instead of Pioneer. If your node fails, Vault shows the error — it never falls back to Pioneer.
      </Text>

      <Text fontSize="11px" color="kk.textSecondary" mb="1">Node type</Text>
      <Flex gap="1.5" mb="2">
        {(["blockbook", "core"] as const).map((tp) => (
          <Box as="button" key={tp} flex="1" onClick={() => setType(tp)}
               py="1.5" borderRadius="8px" fontSize="12px" fontWeight="600"
               border="1px solid" borderColor={type === tp ? `${ACCENT}88` : "kk.border"}
               bg={type === tp ? `${ACCENT}18` : "transparent"} color={type === tp ? "kk.textPrimary" : "kk.textSecondary"}
               _hover={{ color: "kk.textPrimary" }}>
            {tp === "blockbook" ? "Blockbook" : "Bitcoin Core"}
          </Box>
        ))}
      </Flex>
      <Text fontSize="10px" color="kk.textSecondary" mb="2.5">
        {type === "blockbook"
          ? "Trezor indexer — xpub-native, full history. What Pioneer uses."
          : "Bitcoin Core RPC — scantxoutset (no history unless txindex + archival)."}
      </Text>

      <Text fontSize="11px" color="kk.textSecondary" mb="1">{type === "blockbook" ? "Blockbook URL" : "Node RPC URL"}</Text>
      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={type === "blockbook" ? "http://100.117.181.111:9130" : "http://127.0.0.1:8332"}
             bg="var(--ink-0)" border="1px solid" borderColor="kk.border" color="kk.textPrimary" size="sm" fontFamily="mono" fontSize="xs" mb="2" />

      {type === "core" && (
        <>
          <Text fontSize="11px" color="kk.textSecondary" mb="1">Auth — rpcuser:rpcpassword {enabled ? "(leave blank to keep saved)" : ""}</Text>
          <Input value={auth} onChange={(e) => setAuth(e.target.value)} type="password" placeholder="user:password"
                 bg="var(--ink-0)" border="1px solid" borderColor="kk.border" color="kk.textPrimary" size="sm" fontFamily="mono" fontSize="xs" mb="3" />
        </>
      )}

      {result && (
        <Box mb="3" p="2.5" borderRadius="8px" border="1px solid"
             borderColor={result.ok ? "rgba(139,227,196,0.35)" : "rgba(224,140,123,0.35)"}
             bg={result.ok ? "rgba(139,227,196,0.08)" : "rgba(224,140,123,0.08)"}>
          {result.ok ? (
            <>
              <Text fontSize="xs" color="var(--teal)" fontWeight="600">Connected — {result.chain} · height {result.blocks?.toLocaleString()}</Text>
              {type === "blockbook" && result.inSync === false && <Text fontSize="11px" color="var(--gold)" mt="1">⚠ Indexer still syncing — balances may be incomplete until caught up.</Text>}
              {type === "core" && result.pruned && <Text fontSize="11px" color="var(--gold)" mt="1">⚠ Pruned node — balances & sending work, but no transaction history.</Text>}
              {type === "core" && result.txindex === false && <Text fontSize="11px" color="var(--gold)" mt="1">⚠ txindex off — can't spend legacy (1…) inputs. Set txindex=1 to enable.</Text>}
              {type === "core" && result.txindex === undefined && <Text fontSize="11px" color="kk.textSecondary" mt="1">txindex status unknown (old Core) — legacy-input spends may fail.</Text>}
            </>
          ) : (
            <Text fontSize="11px" color="var(--rose)" wordBreak="break-word">{result.error}</Text>
          )}
        </Box>
      )}

      <Flex gap="2">
        <Button size="sm" variant="outline" flex="1" onClick={test} disabled={testing || !url.trim()}
                borderColor="kk.border" color="kk.textPrimary" _hover={{ bg: "var(--ink-2)" }}>
          {testing ? "Testing…" : "Test connection"}
        </Button>
        {enabled ? (
          <Button size="sm" flex="1" onClick={() => save(false)} disabled={saving}
                  bg="rgba(224,140,123,0.15)" color="var(--rose)" _hover={{ bg: "rgba(224,140,123,0.25)" }}>
            {saving ? "…" : "Disable"}
          </Button>
        ) : (
          <Button size="sm" flex="1" onClick={() => save(true)} disabled={saving || !url.trim()}
                  bg="var(--gold)" color="kk.bg" _hover={{ opacity: 0.9 }}>
            {saving ? "…" : "Use my node"}
          </Button>
        )}
      </Flex>
    </Box>
  )
}
