import { useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Text, VStack } from '@chakra-ui/react'
import { SIGNING_REVIEW_EXAMPLES, SIGNING_REVIEW_FAMILIES } from '../../../shared/signing-review-examples'
import { useUiTranslation } from '../../i18n/ui'
import { Z } from '../../lib/z-index'
import { SigningReviewCompanion } from './SigningReviewCompanion'

/** A device-free overview: changing an example never calls a signing RPC. */
export function SigningReviewOverview({ open, onClose }: { open: boolean; onClose: () => void }) {
  const uiText = useUiTranslation()
  const [selected, setSelected] = useState('message')
  const close = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const before = document.activeElement as HTMLElement | null
    close.current?.focus()
    return () => before?.focus()
  }, [open])
  if (!open) return null
  const example = SIGNING_REVIEW_EXAMPLES.find(item => item.id === selected) || SIGNING_REVIEW_EXAMPLES[0]
  return <Box position="fixed" inset="0" zIndex={Z.dialog + 1} display="flex" alignItems="center" justifyContent="center" p="3" bg="rgba(5,9,15,0.86)" fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" css={{ '& button': { fontFamily: 'inherit' } }}
    role="dialog" aria-modal="true" aria-label={uiText('Signing screen guide')} ref={dialog}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      if (event.key === 'Tab') {
        const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
        const first = buttons[0], last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
    <VStack w="1120px" maxW="96vw" maxH="94vh" gap="0" align="stretch" bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="2xl" overflow="hidden">
      <Flex p="5" align="center" justify="space-between" gap="4" borderBottom="1px solid" borderColor="kk.border">
        <Box><Text fontSize="xl" color="kk.textPrimary" fontWeight="700">{uiText('Signing screen guide')}</Text>
          <Text fontSize="sm" color="kk.textSecondary" mt="1">{uiText('Preview in Vault → compare on KeepKey → decide on the device.')}</Text></Box>
        <Button ref={close} variant="outline" onClick={onClose}>{uiText('Close')}</Button>
      </Flex>
      <Flex minH="0" overflowY="auto" direction={{ base: 'column', md: 'row' }}>
        <VStack align="stretch" gap="2" p="4" w={{ base: '100%', md: '280px' }} flexShrink="0" bg="rgba(0,0,0,0.12)">
          <Text fontSize="sm" fontWeight="700" color="kk.textPrimary">{uiText('Explore a flow')}</Text>
          {SIGNING_REVIEW_EXAMPLES.map(item => <Button key={item.id} variant={selected === item.id ? 'solid' : 'ghost'} justifyContent="flex-start" h="auto" py="3" whiteSpace="normal" textAlign="left" aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>{uiText(item.title)}</Button>)}
          <Text fontSize="sm" color="kk.textSecondary" lineHeight="1.65" mt="3">{uiText('These examples use sample data. Opening this guide does not request a signature or change a device policy.')}</Text>
          <Text fontSize="sm" fontWeight="700" color="kk.textPrimary" mt="3">{uiText('Review coverage')}</Text>
          <Text fontSize="sm" lineHeight="1.7" color="kk.textSecondary">{SIGNING_REVIEW_FAMILIES.join(' · ')}</Text>
        </VStack>
        <Box p={{ base: '4', md: '6' }} flex="1" minW="0">
          <Text fontSize="sm" color="kk.textSecondary" mb="4">{uiText(example.description)}</Text>
          <SigningReviewCompanion key={example.id} request={example.request} phase="preview" />
        </Box>
      </Flex>
    </VStack>
  </Box>
}
