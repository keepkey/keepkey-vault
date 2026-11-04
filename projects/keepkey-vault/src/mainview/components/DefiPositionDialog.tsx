import { useState } from 'react'
import { Box, Button, Dialog, Flex, HStack, Image, Link, Portal, Text, VStack } from '@chakra-ui/react'
import { FaExternalLinkAlt, FaTimes } from 'react-icons/fa'
import { useTranslation } from 'react-i18next'
import type { DefiPosition } from '../../shared/types'
import { useFiat } from '../lib/fiat-context'
import { defiExplorerUrl, defiPositionName, defiProtocolUrl, isNativeDefiToken } from '../lib/defi-position'
import { rpcRequest } from '../lib/rpc'
import { Z } from '../lib/z-index'

interface Props {
  position: DefiPosition
  address: string | null
  onClose: () => void
}

export function DefiPositionDialog({ position, address, onClose }: Props) {
  const { t } = useTranslation('asset')
  const { fmt } = useFiat()
  const [linkError, setLinkError] = useState(false)
  const owner = position.pubkey || address
  const protocolUrl = defiProtocolUrl(position.protocol)
  const ownerUrl = defiExplorerUrl(position, owner)
  const contractUrl = defiExplorerUrl(position, position.appTokenAddress)

  const externalLink = (url: string, label: string) => (
    <Link href={url} target="_blank" rel="noopener noreferrer" color="kk.gold" fontSize="xs"
      wordBreak="break-all" onClick={(event) => {
        event.preventDefault()
        setLinkError(false)
        rpcRequest('openUrl', { url }).catch(() => setLinkError(true))
      }}>
      {label}<FaExternalLinkAlt size={10} style={{ flexShrink: 0 }} />
    </Link>
  )

  const detail = (label: string, value: string | null | undefined) => value ? (
    <Box>
      <Text fontSize="xs" color="kk.textMuted" mb="1">{label}</Text>
      <Text fontSize="sm" color="kk.textPrimary" wordBreak="break-word" whiteSpace="pre-wrap">{value}</Text>
    </Box>
  ) : null

  return (
    <Dialog.Root open onOpenChange={({ open }) => { if (!open) onClose() }} placement="center" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop bg="blackAlpha.800" zIndex={Z.dialog} />
        <Dialog.Positioner zIndex={Z.dialog + 1} p="4" onClick={event => event.stopPropagation()}>
          <Dialog.Content bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="xl"
            w="600px" maxW="100%" maxH="85dvh" color="kk.textPrimary">
            <Dialog.Header pr="14">
              <HStack gap="3">
                {position.icon && <Image src={position.icon} alt="" w="36px" h="36px" borderRadius="full" />}
                <Box minW="0">
                  <Dialog.Title fontSize="lg" wordBreak="break-word">{defiPositionName(position)}</Dialog.Title>
                  <Dialog.Description fontSize="xs" color="kk.textSecondary">{t('defiDetails')}</Dialog.Description>
                </Box>
              </HStack>
            </Dialog.Header>
            <Dialog.CloseTrigger asChild>
              <Button position="absolute" top="3" right="3" size="sm" variant="ghost"
                aria-label={t('close', { ns: 'common' })} color="kk.textSecondary"><FaTimes /></Button>
            </Dialog.CloseTrigger>
            <Dialog.Body pb="5">
              <VStack align="stretch" gap="5">
                <Box bg="rgba(255,255,255,0.03)" p="4" borderRadius="lg">
                  <Text fontSize="xs" color="kk.textMuted">{t('defiValue')}</Text>
                  <Text fontSize="2xl" fontWeight="600" fontFamily="mono">{fmt(position.balanceUsd)}</Text>
                  {position.balance != null && <Text fontSize="sm" fontFamily="mono" wordBreak="break-all">
                    {position.balance}{position.symbol ? ` ${position.symbol}` : ''}
                  </Text>}
                </Box>
                <Flex gap="5" wrap="wrap">
                  {detail(t('defiProtocol'), position.displayName || position.protocol)}
                  {position.displayName && position.protocol && position.displayName !== position.protocol && detail(t('defiProtocolId'), position.protocol)}
                  {detail(t('defiNetwork'), position.network)}
                  {detail(t('defiNetworkId'), position.networkId)}
                  {detail(t('defiPositionType'), position.type)}
                  {detail(t('defiPositionCategory'), position.metaType)}
                  {!position.balance && detail(t('defiSymbol'), position.symbol)}
                </Flex>
                {owner && <Box>
                  {detail(t('defiOwner'), owner)}
                  {ownerUrl && externalLink(ownerUrl, t('defiViewWallet'))}
                </Box>}
                {position.appTokenAddress && <Box>
                  {detail(t('defiContract'), position.appTokenAddress)}
                  {contractUrl && !isNativeDefiToken(position.appTokenAddress) && externalLink(contractUrl, t('defiViewContract'))}
                </Box>}
                {!!position.tokens?.length && <Box>
                  <Text fontSize="sm" fontWeight="600" mb="2">{t('defiUnderlyingTokens')}</Text>
                  <VStack align="stretch" gap="2">
                    {position.tokens.map((token, index) => {
                      const native = isNativeDefiToken(token.address)
                      const tokenUrl = native ? undefined : defiExplorerUrl(position, token.address, token.networkId)
                      return (
                        <Box key={`${token.networkId}-${token.address}-${index}`} p="3" bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="kk.border" borderRadius="lg">
                          <Flex justify="space-between" gap="3" wrap="wrap">
                            <Text fontSize="sm" fontWeight="600">{token.symbol || t('defiToken')}</Text>
                            {token.balanceUsd != null && <Text fontSize="sm" fontFamily="mono">{fmt(token.balanceUsd)}</Text>}
                          </Flex>
                          <Text fontSize="sm" fontFamily="mono" wordBreak="break-all" mt="1">
                            {token.balance != null ? `${token.balance}${token.symbol ? ` ${token.symbol}` : ''}` : t('defiAmountUnavailable')}
                          </Text>
                          <Text fontSize="xs" color="kk.textMuted" mt="1">{token.networkId || position.networkId || position.network}</Text>
                          {native && <Text fontSize="xs" color="kk.textSecondary" mt="1">{t('defiNativeToken')}</Text>}
                          <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary" wordBreak="break-all" mt="1">{token.address}</Text>
                          {tokenUrl && externalLink(tokenUrl, t('defiViewContract'))}
                        </Box>
                      )
                    })}
                  </VStack>
                </Box>}
                {protocolUrl && externalLink(protocolUrl, t('defiOpenProtocol'))}
                {linkError && <Text role="alert" fontSize="xs" color="red.300">{t('defiLinkError')}</Text>}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer borderTop="1px solid" borderColor="kk.border">
              <Dialog.ActionTrigger asChild><Button size="sm" variant="outline">{t('close', { ns: 'common' })}</Button></Dialog.ActionTrigger>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
