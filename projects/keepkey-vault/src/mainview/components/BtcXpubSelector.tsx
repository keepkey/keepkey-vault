import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { FaPlus } from "react-icons/fa"
import { BTC_SCRIPT_TYPES } from "../../shared/chains"
import { formatBalance, formatUsd } from "../lib/formatting"
import type { BtcAccountSet, BtcScriptType } from "../../shared/types"

interface BtcXpubSelectorProps {
  btcAccounts: BtcAccountSet
  onSelectXpub: (accountIndex: number, scriptType: BtcScriptType) => void
  onAddAccount: () => void
  addingAccount: boolean
}

export function BtcXpubSelector({ btcAccounts, onSelectXpub, onAddAccount, addingAccount }: BtcXpubSelectorProps) {
  const { accounts, selectedXpub } = btcAccounts
  if (accounts.length === 0) return null

  const selAcct = selectedXpub?.accountIndex ?? 0
  const selScript = selectedXpub?.scriptType ?? 'p2wpkh'

  // Find the active account's xpubs
  const activeAccount = accounts.find(a => a.accountIndex === selAcct) || accounts[0]

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
            Account {acct.accountIndex}
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
        {BTC_SCRIPT_TYPES.map(st => {
          const xpubData = activeAccount.xpubs.find(x => x.scriptType === st.scriptType)
          const isSelected = selAcct === activeAccount.accountIndex && selScript === st.scriptType
          const hasBalance = (xpubData?.balanceUsd ?? 0) > 0

          return (
            <Box
              key={st.scriptType}
              as="button"
              onClick={() => onSelectXpub(activeAccount.accountIndex, st.scriptType)}
              bg={isSelected ? "rgba(255,215,0,0.12)" : "rgba(255,255,255,0.03)"}
              border="1px solid"
              borderColor={isSelected ? "kk.gold" : "kk.border"}
              borderRadius="lg"
              px="3"
              py="1.5"
              cursor="pointer"
              transition="all 0.15s"
              _hover={{ borderColor: "kk.gold", bg: "rgba(255,215,0,0.06)" }}
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
                {xpubData && hasBalance && (
                  <Text fontSize="10px" fontFamily="mono" color="kk.textMuted" lineHeight="1.2">
                    {formatBalance(xpubData.balance)} BTC
                  </Text>
                )}
                {xpubData && xpubData.balanceUsd > 0 && (
                  <Text fontSize="9px" color="kk.textMuted" lineHeight="1.2">
                    ${formatUsd(xpubData.balanceUsd)}
                  </Text>
                )}
              </Flex>
            </Box>
          )
        })}
      </Flex>
    </Box>
  )
}
