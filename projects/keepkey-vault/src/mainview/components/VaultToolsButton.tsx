import { useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Text } from '@chakra-ui/react'
import { usePasswordManagerEnabled } from '../hooks/usePasswordManagerEnabled'
import { useUiTranslation } from '../i18n/ui'
import { Z } from '../lib/z-index'
import { Bip85VaultDialog } from './Bip85VaultDialog'
import { PasswordBankView } from './PasswordBankView'

/** One entry for password and seed tools; feature switches never add
 * another global navigation tab. */
export function VaultToolsButton({ seedVaultAvailable, passwordsAvailable = true }: {
  seedVaultAvailable: boolean; passwordsAvailable?: boolean
}) {
  const uiText = useUiTranslation()
  const passwordFlag = usePasswordManagerEnabled()
  const passwords = passwordFlag && passwordsAvailable
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<'passwords' | 'seeds'>('passwords')
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const close = () => { setOpen(false); trigger.current?.focus() }
  useEffect(() => {
    if (!passwords && section === 'passwords') {
      if (seedVaultAvailable) setSection('seeds')
      else setOpen(false)
    }
  }, [passwords, section, seedVaultAvailable])
  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    // A completed operation can remove its focused button. Escape must still
    // close the panel when the browser has returned focus to the document.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      setOpen(false); trigger.current?.focus()
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [open])
  if (!seedVaultAvailable && !passwords) return null
  return <>
    <Button ref={trigger} position="fixed" bottom="76px" right="28px" w="52px" h="52px" minW="52px" p="0"
      borderRadius="full" bg="rgba(233,196,106,0.22)" border="1.5px solid rgba(233,196,106,0.7)"
      boxShadow="0 0 16px rgba(233,196,106,0.25)" zIndex={10}
      _hover={{ bg: 'rgba(233,196,106,0.32)', borderColor: 'kk.gold' }}
      aria-label={passwords ? uiText('Passwords and seed vault') : uiText('BIP-85 Seed Vault')}
      title={passwords ? uiText('Passwords and seed vault') : uiText('BIP-85 Seed Vault')}
      onClick={() => { setSection(passwords ? 'passwords' : 'seeds'); setOpen(true) }}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {/* A safe, not a padlock: this opens the vault tools and locks nothing. */}
        <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="12" cy="12" r="3" /><path d="M12 9V7M12 17v-2M9 12H7M17 12h-2" />
      </svg>
    </Button>
    {open && <>
      <Box position="fixed" inset="0" bg="blackAlpha.700" zIndex={Z.dialog} onClick={close} />
      <Box ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={uiText('Vault')}
        position="fixed" top="50%" left="50%" transform="translate(-50%, -50%)"
        w={section === 'passwords' && passwords ? '760px' : '520px'} maxW="94vw" maxH="88vh"
        bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="xl" zIndex={Z.dialog + 1}
        display="flex" flexDirection="column" overflow="hidden"
        onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); close() }
          if (event.key !== 'Tab') return
          const nodes = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]') || [])].filter(n => n.offsetParent !== null)
          const first = nodes[0], last = nodes[nodes.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus() }
        }}>
        <Flex px="5" py="3" align="center" justify="space-between" gap="3" borderBottom="1px solid" borderColor="kk.border">
          <Text fontSize="lg" fontWeight="600">{uiText('Vault')}</Text>
          <Button size="xs" variant="ghost" color="kk.textSecondary" aria-label={uiText('Close vault')} onClick={close}>×</Button>
        </Flex>
        <Flex as="nav" aria-label={uiText('Vault tools')} gap="2" px="5" py="3" borderBottom="1px solid" borderColor="kk.border">
          {passwords && <Button size="sm" color={section === 'passwords' ? 'kk.textPrimary' : 'kk.textSecondary'} variant={section === 'passwords' ? 'solid' : 'ghost'} aria-pressed={section === 'passwords'} onClick={() => setSection('passwords')}>{uiText('Passwords')}</Button>}
          {seedVaultAvailable && <Button size="sm" color={section === 'seeds' ? 'kk.textPrimary' : 'kk.textSecondary'} variant={section === 'seeds' ? 'solid' : 'ghost'} aria-pressed={section === 'seeds'} onClick={() => setSection('seeds')}>{uiText('Seed vault (BIP-85)')}</Button>}
        </Flex>
        <Box overflow="auto" minH="0">
          {section === 'passwords' && passwords ? <PasswordBankView /> : seedVaultAvailable ? <Bip85VaultDialog embedded onClose={close} /> : null}
        </Box>
      </Box>
    </>}
  </>
}
