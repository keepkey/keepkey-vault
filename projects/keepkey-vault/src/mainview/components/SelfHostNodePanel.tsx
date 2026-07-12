import { useState } from "react"
import { Box, Flex, Text, Input, Button } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import type { AppSettings } from "../../shared/types"

type TestResult = { ok: boolean; error?: string; chain?: string; blocks?: number; pruned?: boolean; txindex?: boolean }

/** Self-host Bitcoin node config (btc-only). Point Vault at your own Bitcoin Core
 *  node instead of Pioneer. Verbose Test Connection; no silent fallback — if the
 *  node is enabled and fails, the app surfaces the error rather than phoning home. */
export function SelfHostNodePanel({ settings, onChange }: { settings: AppSettings; onChange: (s: AppSettings) => void }) {
  const [url, setUrl] = useState(settings.btcNodeUrl || "")
  const [auth, setAuth] = useState("")
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const enabled = settings.btcNodeEnabled

  const test = async () => {
    setTesting(true); setResult(null)
    try {
      setResult(await rpcRequest<TestResult>("testBtcNode", { url: url.trim(), auth: auth || undefined }, 20000))
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || "Test failed" })
    }
    setTesting(false)
  }

  const save = async (nextEnabled: boolean) => {
    setSaving(true)
    try {
      const s = await rpcRequest<AppSettings>("setBtcNode", { enabled: nextEnabled, url: url.trim(), auth: auth || undefined }, 10000)
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
        Point Vault at your own Bitcoin Core node instead of Pioneer. If your node fails, Vault shows the error — it never falls back to Pioneer.
      </Text>

      <Text fontSize="11px" color="kk.textSecondary" mb="1">Node RPC URL</Text>
      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:8332"
             bg="var(--ink-0)" border="1px solid" borderColor="kk.border" color="kk.textPrimary" size="sm" fontFamily="mono" fontSize="xs" mb="2" />

      <Text fontSize="11px" color="kk.textSecondary" mb="1">Auth — rpcuser:rpcpassword {enabled ? "(leave blank to keep saved)" : ""}</Text>
      <Input value={auth} onChange={(e) => setAuth(e.target.value)} type="password" placeholder="user:password"
             bg="var(--ink-0)" border="1px solid" borderColor="kk.border" color="kk.textPrimary" size="sm" fontFamily="mono" fontSize="xs" mb="3" />

      {result && (
        <Box mb="3" p="2.5" borderRadius="8px" border="1px solid"
             borderColor={result.ok ? "rgba(139,227,196,0.35)" : "rgba(224,140,123,0.35)"}
             bg={result.ok ? "rgba(139,227,196,0.08)" : "rgba(224,140,123,0.08)"}>
          {result.ok ? (
            <>
              <Text fontSize="xs" color="var(--teal)" fontWeight="600">Connected — {result.chain} · height {result.blocks?.toLocaleString()}</Text>
              {result.pruned && <Text fontSize="11px" color="var(--gold)" mt="1">⚠ Pruned node — balances & sending work, but no transaction history.</Text>}
              {result.txindex === false && <Text fontSize="11px" color="var(--gold)" mt="1">⚠ txindex off — can't spend legacy (1…) inputs. Set txindex=1 to enable.</Text>}
              {result.txindex === undefined && <Text fontSize="11px" color="kk.textSecondary" mt="1">txindex status unknown (old Core) — legacy-input spends may fail.</Text>}
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
