import { useEffect, useRef, useState } from "react"
import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { FaPlus, FaCheck, FaChevronDown, FaTimes, FaExclamationTriangle } from "react-icons/fa"
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
          onClick={() => setOpen(true)}
          _hover={{ opacity: 0.8 }}
        >
          {t('btcAccountType.learnMore', { defaultValue: 'Learn more' })}
        </Text>
      </Flex>
      {open && <BitcoinScriptTypeDialog onClose={() => setOpen(false)} />}
    </Box>
  )
}

const SCRIPT_TYPE_GUIDE = [
  {
    name: 'Legacy', standard: 'P2PKH', address: '1…', introduced: '2009',
    fee: '~148 vB per input', feeLabel: 'Highest fees', compatibility: 'Universal compatibility',
    detail: 'The original Bitcoin address format. Use it only when a service does not accept newer address types.',
  },
  {
    name: 'Nested SegWit', standard: 'P2SH-P2WPKH', address: '3…', introduced: '2017',
    fee: '~91 vB per input', feeLabel: 'Lower fees', compatibility: 'Excellent compatibility',
    detail: 'SegWit wrapped for older software. A useful fallback when a sender rejects bc1 addresses.',
  },
  {
    name: 'Native SegWit', standard: 'P2WPKH / Bech32', address: 'bc1q…', introduced: '2017',
    fee: '~68 vB per input', feeLabel: 'Low fees', compatibility: 'Broad modern support',
    detail: 'The best default for most people: efficient, widely supported, and less expensive to spend.',
    recommended: true,
  },
  {
    name: 'Taproot', standard: 'P2TR / Bech32m', address: 'bc1p…', introduced: '2021',
    fee: '~58 vB per key-path input', feeLabel: 'Lowest key-path fees', compatibility: 'Support still varies',
    detail: 'Efficient and privacy-friendly for supported transactions, but some exchanges, wallets, and services still cannot send to bc1p addresses.',
    warning: true,
  },
]

function BitcoinScriptTypeDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <Box
      position="fixed" inset="0" zIndex={12000} bg="rgba(2,3,6,0.82)" backdropFilter="blur(10px)"
      display="flex" alignItems="center" justifyContent="center" p={{ base: '3', md: '8' }}
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
      role="dialog" aria-modal="true" aria-labelledby="bitcoin-script-guide-title"
    >
      <Box
        w="100%" maxW="880px" maxH="88vh" overflowY="auto" borderRadius="2xl"
        bg="rgba(15,17,21,0.98)" border="1px solid rgba(233,196,106,0.28)"
        boxShadow="0 28px 90px rgba(0,0,0,0.65)" p={{ base: '4', md: '6' }}
      >
        <Flex justify="space-between" align="flex-start" gap="4" mb="5">
          <Box>
            <Text id="bitcoin-script-guide-title" fontSize={{ base: 'xl', md: '2xl' }} fontWeight="700" color="kk.textPrimary">
              Bitcoin address types
            </Text>
            <Text mt="1" fontSize="sm" color="kk.textSecondary" maxW="680px" lineHeight="1.6">
              These are separate accounts derived from the same recovery phrase. Funds remain yours in every account; the format mainly changes fees and service compatibility.
            </Text>
          </Box>
          <Box as="button" aria-label="Close" onClick={onClose} color="kk.textMuted" p="2" borderRadius="lg" _hover={{ color: 'white', bg: 'rgba(255,255,255,0.06)' }}>
            <Box as={FaTimes} />
          </Box>
        </Flex>

        <Box display="grid" gridTemplateColumns={{ base: '1fr', md: 'repeat(2, 1fr)' }} gap="3">
          {SCRIPT_TYPE_GUIDE.map(item => (
            <Box key={item.standard} position="relative" p="4" borderRadius="xl" bg="rgba(255,255,255,0.025)" border="1px solid" borderColor={item.recommended ? 'rgba(233,196,106,0.55)' : 'kk.border'}>
              {item.recommended && (
                <Text position="absolute" top="3" right="3" fontSize="9px" fontWeight="700" letterSpacing="0.08em" color="kk.gold" textTransform="uppercase">Recommended</Text>
              )}
              <Flex align="baseline" gap="2" pr={item.recommended ? '24' : '0'}>
                <Text fontSize="md" fontWeight="700" color="kk.textPrimary">{item.name}</Text>
                <Text fontSize="11px" fontFamily="mono" color="kk.gold">{item.address}</Text>
              </Flex>
              <Text mt="0.5" fontSize="10px" fontFamily="mono" color="kk.textMuted">{item.standard} · introduced {item.introduced}</Text>
              <Flex mt="3" gap="2" flexWrap="wrap">
                <Box px="2" py="1" borderRadius="md" bg="rgba(139,227,196,0.08)">
                  <Text fontSize="10px" color="var(--teal)">{item.feeLabel} · {item.fee}</Text>
                </Box>
                <Box px="2" py="1" borderRadius="md" bg="rgba(255,255,255,0.05)">
                  <Text fontSize="10px" color="kk.textSecondary">{item.compatibility}</Text>
                </Box>
              </Flex>
              <Text mt="3" fontSize="12px" color="kk.textSecondary" lineHeight="1.6">{item.detail}</Text>
              {item.warning && (
                <Flex mt="3" gap="2" align="flex-start" p="2.5" borderRadius="lg" bg="rgba(246,173,85,0.08)" border="1px solid rgba(246,173,85,0.22)">
                  <Box as={FaExclamationTriangle} color="orange.300" fontSize="11px" mt="0.5" flexShrink={0} />
                  <Text fontSize="10px" color="orange.200" lineHeight="1.5">Confirm the sending service supports Taproot or bc1p before using this address.</Text>
                </Flex>
              )}
            </Box>
          ))}
        </Box>

        <Text mt="4" fontSize="10px" color="kk.textMuted" lineHeight="1.5">
          Input sizes are typical spending estimates, not quoted transaction fees. Your final fee also depends on the number and type of inputs and outputs, transaction structure, and the current fee rate.
        </Text>
        <Flex justify="flex-end" mt="5">
          <Button size="sm" bg="kk.gold" color="black" _hover={{ bg: 'kk.goldHover' }} onClick={onClose}>Got it</Button>
        </Flex>
      </Box>
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
