import { useEffect, useRef, useState } from "react"
import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { FaPlus, FaCheck, FaChevronDown } from "react-icons/fa"
import { useTranslation } from "react-i18next"
import { BTC_SCRIPT_TYPES, btcScriptTypeConfig } from "../../shared/chains"
import { formatBalance } from "../lib/formatting"
import { AnimatedUsd } from "./AnimatedUsd"
import type { BtcAccountSet, BtcScriptType } from "../../shared/types"

interface BtcXpubSelectorProps {
  btcAccounts: BtcAccountSet
  onSelectXpub: (accountIndex: number, scriptType: BtcScriptType) => void
  onAddAccount: () => void
  addingAccount: boolean
  /**
   * Compact dropdown variant from the AssetPage design study. Renders the
   * account + script-type pickers as two glass-pill dropdowns side by side
   * so the selector fits inline with the Receive/Send/Swap action pills
   * instead of taking two chip rows.
   */
  compact?: boolean
}

export function BtcXpubSelector({ btcAccounts, onSelectXpub, onAddAccount, addingAccount, compact }: BtcXpubSelectorProps) {
  const { accounts, selectedXpub } = btcAccounts
  const { t } = useTranslation("receive")
  if (accounts.length === 0) return null

  const selAcct = selectedXpub?.accountIndex ?? 0
  const selScript = selectedXpub?.scriptType ?? 'p2wpkh'

  // Find the active account's xpubs
  const activeAccount = accounts.find(a => a.accountIndex === selAcct) || accounts[0]

  if (compact) {
    return (
      <CompactBtcSelector
        accounts={accounts}
        activeAccount={activeAccount}
        selAcct={selAcct}
        selScript={selScript}
        onSelectXpub={onSelectXpub}
        onAddAccount={onAddAccount}
        addingAccount={addingAccount}
        t={t}
      />
    )
  }

  return (
    <Box mb="3">
      {/* Account tabs */}
      <Flex gap="1" mb="2" align="center" flexWrap="wrap">
        {accounts.map(acct => (
          <Button
            key={acct.accountIndex}
            size="xs"
            variant={acct.accountIndex === selAcct ? "solid" : "outline"}
            bg={acct.accountIndex === selAcct ? "kk.gold" : "transparent"}
            color={acct.accountIndex === selAcct ? "black" : "kk.textSecondary"}
            borderColor="kk.border"
            _hover={{ bg: acct.accountIndex === selAcct ? "kk.goldHover" : "rgba(255,255,255,0.06)" }}
            onClick={() => onSelectXpub(acct.accountIndex, selScript)}
            fontSize="11px"
            px="3"
          >
            {t('account', { index: acct.accountIndex })}
          </Button>
        ))}
        <Button
          size="xs"
          variant="ghost"
          color="kk.textMuted"
          _hover={{ color: "kk.gold" }}
          onClick={onAddAccount}
          disabled={addingAccount}
          px="2"
          minW="auto"
        >
          <Box as={FaPlus} fontSize="10px" />
        </Button>
      </Flex>

      {/* Script type pills */}
      <Flex gap="1.5" flexWrap="wrap">
        {activeAccount.xpubs.map(xpubData => {
          const st = btcScriptTypeConfig(xpubData.scriptType)
          if (!st) return null
          const isSelected = selAcct === activeAccount.accountIndex && selScript === st.scriptType
          const hasBtcBalance = xpubData ? parseFloat(xpubData.balance || '0') > 0 : false

          return (
            <Box
              key={st.scriptType}
              as="button"
              onClick={() => onSelectXpub(activeAccount.accountIndex, st.scriptType)}
              bg={isSelected ? "rgba(233,196,106,0.12)" : "rgba(255,255,255,0.03)"}
              border="1px solid"
              borderColor={isSelected ? "kk.gold" : "kk.border"}
              borderRadius="lg"
              px="3"
              py="1.5"
              cursor="pointer"
              transition="all 0.15s"
              _hover={{ borderColor: "kk.gold", bg: "rgba(233,196,106,0.06)" }}
              flex="1"
              minW="0"
            >
              <Flex direction="column" align="center" gap="0.5">
                <Text fontSize="11px" fontWeight="600" color={isSelected ? "kk.gold" : "kk.textPrimary"} lineHeight="1.2">
                  {st.label}
                </Text>
                <Text fontSize="10px" fontFamily="mono" color="kk.textMuted" lineHeight="1.2">
                  {st.addressPrefix}...
                </Text>
                {xpubData && (
                  <Text fontSize="10px" fontFamily="mono" color={hasBtcBalance ? "white" : "kk.textMuted"} fontWeight="500" lineHeight="1.2">
                    {formatBalance(xpubData.balance)} BTC
                  </Text>
                )}
                {xpubData && (
                  <AnimatedUsd value={xpubData.balanceUsd || 0} fontSize="9px" fontWeight="500" lineHeight="1.2" />
                )}
              </Flex>
            </Box>
          )
        })}
      </Flex>
      <BtcAccountTypeHelp />
    </Box>
  )
}

/**
 * "Which one is right?" is the single most common question on this control, and
 * "there's no wrong answer" is a non-answer — users read it as the app dodging.
 * Give a default, say what actually differs (fees and compatibility), and put
 * the rest behind a link.
 */
function BtcAccountTypeHelp() {
  const { t } = useTranslation("receive")
  const [open, setOpen] = useState(false)
  return (
    <Box mt="1.5">
      <Flex align="center" gap="1" flexWrap="wrap">
        <Text fontSize="10px" color="kk.textMuted" lineHeight="1.5">
          {t('btcAccountType.recommendation', {
            defaultValue: 'Not sure? Use Native SegWit (bc1…) — it has the lowest fees and is supported by every modern wallet and exchange.',
          })}
        </Text>
        <Text
          as="button"
          fontSize="10px"
          color="kk.gold"
          textDecoration="underline"
          lineHeight="1.5"
          onClick={() => setOpen(o => !o)}
          _hover={{ opacity: 0.8 }}
        >
          {open
            ? t('btcAccountType.hide', { defaultValue: 'Hide' })
            : t('btcAccountType.learnMore', { defaultValue: 'Learn more' })}
        </Text>
      </Flex>
      {open && (
        <Box mt="1.5" p="2.5" bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="kk.border" borderRadius="lg">
          <Text fontSize="10px" color="kk.textSecondary" lineHeight="1.7">
            {t('btcAccountType.explainer', {
              defaultValue:
                'All three hold real bitcoin from the same recovery phrase — they are different address formats, not different wallets, and switching between them never puts funds at risk. Native SegWit (bc1…) costs the least to spend. SegWit (3…) is a middle ground for older services that reject bc1 addresses. Legacy (1…) is the original format: it works everywhere but costs the most in fees. If you are receiving from a service that rejects your address, pick the format it accepts — your coins stay accessible under all three.',
            })}
          </Text>
        </Box>
      )}
    </Box>
  )
}

// ─── Compact dropdown variant ─────────────────────────────────────────

interface CompactBtcSelectorProps {
  accounts: BtcAccountSet["accounts"]
  activeAccount: BtcAccountSet["accounts"][number]
  selAcct: number
  selScript: BtcScriptType
  onSelectXpub: (accountIndex: number, scriptType: BtcScriptType) => void
  onAddAccount: () => void
  addingAccount: boolean
  t: (key: string, opts?: any) => string
}

function CompactBtcSelector({
  accounts, activeAccount, selAcct, selScript, onSelectXpub, onAddAccount, addingAccount, t,
}: CompactBtcSelectorProps) {
  const [accountOpen, setAccountOpen] = useState(false)
  const [scriptOpen, setScriptOpen] = useState(false)
  const accountRef = useRef<HTMLDivElement | null>(null)
  const scriptRef = useRef<HTMLDivElement | null>(null)

  // Click-outside + Escape close (each menu independently).
  useEffect(() => {
    if (!accountOpen && !scriptOpen) return
    const onDown = (e: MouseEvent) => {
      if (accountOpen && accountRef.current && !accountRef.current.contains(e.target as Node)) setAccountOpen(false)
      if (scriptOpen && scriptRef.current && !scriptRef.current.contains(e.target as Node)) setScriptOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setAccountOpen(false); setScriptOpen(false) } }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [accountOpen, scriptOpen])

  const activeScript = btcScriptTypeConfig(selScript) || BTC_SCRIPT_TYPES[0]
  const activeScriptXpub = activeAccount.xpubs.find(x => x.scriptType === activeScript.scriptType)
  const activeScriptBalance = activeScriptXpub ? formatBalance(activeScriptXpub.balance) : '0'

  return (
    <Flex gap="2" align="center">
      {/* Account dropdown */}
      <Box ref={accountRef} position="relative" display="inline-block">
        <Box
          as="button"
          onClick={() => { setAccountOpen(o => !o); setScriptOpen(false) }}
          className="v3-glass-pill electrobun-webkit-app-region-no-drag"
          display="flex"
          alignItems="center"
          gap="2"
          px="3"
          py="1.5"
          minW="150px"
          cursor="pointer"
          transition="all 0.15s"
          _hover={{ bg: "rgba(255,255,255,0.06)" }}
          aria-haspopup="menu"
          aria-expanded={accountOpen}
        >
          <Box
            w="22px" h="22px" borderRadius="full" bg="rgba(255,255,255,0.06)"
            display="flex" alignItems="center" justifyContent="center" flexShrink={0}
          >
            <Text fontSize="9px" fontFamily="mono" color="var(--text-2)" fontWeight="600">
              #{selAcct}
            </Text>
          </Box>
          <Box flex="1" textAlign="left" minW="0">
            <Text fontSize="12px" fontWeight="600" color="var(--text-0)" lineHeight="1.1" truncate>
              {t('account', { index: selAcct })}
            </Text>
            <Text fontSize="10px" fontFamily="mono" color="var(--text-3)" lineHeight="1.2" truncate>
              {activeScriptBalance} BTC
            </Text>
          </Box>
          <Box as={FaChevronDown} fontSize="9px" color="var(--text-3)" flexShrink={0} />
        </Box>

        {accountOpen && (
          <Box
            position="absolute"
            top="calc(100% + 6px)"
            left="0"
            minW="240px"
            zIndex={9999}
            className="v3-glass-card-overlay electrobun-webkit-app-region-no-drag"
            py="1.5"
          >
            {accounts.map(acct => {
              const isSel = acct.accountIndex === selAcct
              const totalBtc = acct.xpubs.reduce((s, x) => s + parseFloat(x.balance || '0'), 0)
              return (
                <Box
                  key={acct.accountIndex}
                  as="button"
                  w="100%" px="3" py="2"
                  bg="transparent"
                  _hover={{ bg: "rgba(255,255,255,0.08)" }}
                  cursor="pointer"
                  textAlign="left"
                  onClick={() => { onSelectXpub(acct.accountIndex, selScript); setAccountOpen(false) }}
                  role="menuitemradio"
                  aria-checked={isSel}
                >
                  <Flex align="center" gap="2.5">
                    <Box
                      w="22px" h="22px" borderRadius="full"
                      bg={isSel ? "rgba(139,227,196,0.15)" : "rgba(255,255,255,0.06)"}
                      display="flex" alignItems="center" justifyContent="center" flexShrink={0}
                    >
                      <Text fontSize="9px" fontFamily="mono" color={isSel ? "var(--teal)" : "var(--text-2)"} fontWeight="600">
                        #{acct.accountIndex}
                      </Text>
                    </Box>
                    <Box flex="1" minW="0">
                      <Text fontSize="12px" fontWeight="600" color="var(--text-0)" lineHeight="1.1">
                        {t('account', { index: acct.accountIndex })}
                      </Text>
                      <Text fontSize="10px" fontFamily="mono" color="var(--text-2)" lineHeight="1.2" truncate>
                        {totalBtc > 0 ? `${formatBalance(String(totalBtc))} BTC` : '0 BTC'}
                      </Text>
                    </Box>
                    {isSel && <Box as={FaCheck} color="var(--teal)" fontSize="10px" flexShrink={0} />}
                  </Flex>
                </Box>
              )
            })}
            <Box borderTop="1px solid rgba(255,255,255,0.06)" mt="1" pt="1">
              <Box
                as="button"
                w="100%" px="3" py="2"
                bg="transparent"
                _hover={{ bg: "rgba(255,255,255,0.08)" }}
                cursor={addingAccount ? "wait" : "pointer"}
                opacity={addingAccount ? 0.5 : 1}
                textAlign="left"
                onClick={() => { if (!addingAccount) { onAddAccount(); setAccountOpen(false) } }}
                aria-disabled={addingAccount}
              >
                <Flex align="center" gap="2.5">
                  <Box
                    w="22px" h="22px" borderRadius="full" bg="rgba(139,227,196,0.10)"
                    display="flex" alignItems="center" justifyContent="center" flexShrink={0}
                  >
                    <Box as={FaPlus} fontSize="9px" color="var(--teal)" />
                  </Box>
                  <Text fontSize="12px" fontWeight="500" color="var(--teal)">
                    Add account
                  </Text>
                </Flex>
              </Box>
            </Box>
          </Box>
        )}
      </Box>

      {/* Script-type dropdown */}
      <Box ref={scriptRef} position="relative" display="inline-block">
        <Box
          as="button"
          onClick={() => { setScriptOpen(o => !o); setAccountOpen(false) }}
          className="v3-glass-pill electrobun-webkit-app-region-no-drag"
          display="flex"
          alignItems="center"
          gap="2"
          px="3"
          py="1.5"
          minW="160px"
          cursor="pointer"
          transition="all 0.15s"
          _hover={{ bg: "rgba(255,255,255,0.06)" }}
          aria-haspopup="menu"
          aria-expanded={scriptOpen}
        >
          <Box flex="1" textAlign="left" minW="0">
            <Text fontSize="12px" fontWeight="600" color="var(--text-0)" lineHeight="1.1" truncate>
              {activeScript.label}
            </Text>
            <Text fontSize="10px" fontFamily="mono" color="var(--text-3)" lineHeight="1.2" truncate>
              {activeScript.addressPrefix}…
            </Text>
          </Box>
          <Box as={FaChevronDown} fontSize="9px" color="var(--text-3)" flexShrink={0} />
        </Box>

        {scriptOpen && (
          <Box
            position="absolute"
            top="calc(100% + 6px)"
            left="0"
            minW="240px"
            zIndex={9999}
            className="v3-glass-card-overlay electrobun-webkit-app-region-no-drag"
            py="1.5"
          >
            {activeAccount.xpubs.map(xpub => {
              const st = btcScriptTypeConfig(xpub.scriptType)
              if (!st) return null
              const hasBal = xpub ? parseFloat(xpub.balance || '0') > 0 : false
              const isSel = selScript === st.scriptType
              return (
                <Box
                  key={st.scriptType}
                  as="button"
                  w="100%" px="3" py="2"
                  bg="transparent"
                  _hover={{ bg: "rgba(255,255,255,0.08)" }}
                  cursor="pointer"
                  textAlign="left"
                  onClick={() => { onSelectXpub(activeAccount.accountIndex, st.scriptType); setScriptOpen(false) }}
                  role="menuitemradio"
                  aria-checked={isSel}
                >
                  <Flex align="center" gap="2.5">
                    <Box flex="1" minW="0">
                      <Text fontSize="12px" fontWeight="600" color="var(--text-0)" lineHeight="1.1">
                        {st.label}
                      </Text>
                      <Flex align="center" gap="1.5" mt="0.5">
                        <Text fontSize="10px" fontFamily="mono" color="var(--text-2)" lineHeight="1.2">
                          {st.addressPrefix}…
                        </Text>
                        {xpub && (
                          <Text fontSize="10px" fontFamily="mono" color={hasBal ? "var(--text-0)" : "var(--text-3)"} lineHeight="1.2">
                            · {formatBalance(xpub.balance)} BTC
                          </Text>
                        )}
                      </Flex>
                    </Box>
                    {isSel && <Box as={FaCheck} color="var(--teal)" fontSize="10px" flexShrink={0} />}
                  </Flex>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    </Flex>
  )
}
