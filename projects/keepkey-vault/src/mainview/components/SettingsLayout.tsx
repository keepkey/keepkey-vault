import { createContext, useContext } from 'react'
import { Box, Button, Flex, Text, VStack } from '@chakra-ui/react'
import { useUiTranslation } from '../i18n/ui'

export type SettingsCategory = 'general' | 'device' | 'security' | 'networks' | 'connections' | 'features' | 'advanced'
const SettingsCategoryContext = createContext<SettingsCategory>('general')
export const useSettingsCategory = () => useContext(SettingsCategoryContext)

export function SettingsLayout({ category, onChange, children }: {
  category: SettingsCategory; onChange: (category: SettingsCategory) => void; children: React.ReactNode
}) {
  const uiText = useUiTranslation()
  const pages: Array<{ id: SettingsCategory; label: string; description: string }> = [
    { id: 'general', label: uiText('General'), description: uiText('Language, display preferences and app updates.') },
    { id: 'device', label: uiText('Device'), description: uiText('Your KeepKey and its firmware.') },
    { id: 'security', label: uiText('Security'), description: uiText('PIN, wallet privacy and signing permissions.') },
    { id: 'networks', label: uiText('Networks'), description: uiText('Choose your networks and manage node connections.') },
    { id: 'connections', label: uiText('Connections'), description: uiText('Connected apps, browser access and API services.') },
    { id: 'features', label: uiText('Feature Flags'), description: uiText('Optional features. Each switch is independent.') },
    { id: 'advanced', label: uiText('Advanced'), description: uiText('Development options and reset controls.') },
  ]
  const page = pages.find(page => page.id === category)!
  return <SettingsCategoryContext.Provider value={category}>
    <Flex flex="1" minH="0" direction={{ base: 'column', md: 'row' }}>
      <Box as="nav" aria-label={uiText('Settings sections')} w={{ base: '100%', md: '176px' }} flexShrink="0"
        p="3" borderRightWidth={{ base: '0', md: '1px' }} borderBottomWidth={{ base: '1px', md: '0' }} borderColor="kk.border" bg="kk.cardBg">
        <Flex direction={{ base: 'row', md: 'column' }} wrap={{ base: 'wrap', md: 'nowrap' }} gap="1">
          {pages.map(item => <Button key={item.id} type="button" variant="ghost" size="sm" justifyContent="flex-start"
            aria-current={category === item.id ? 'page' : undefined} onClick={() => onChange(item.id)}
            color={category === item.id ? 'kk.textPrimary' : 'kk.textSecondary'} fontWeight={category === item.id ? '600' : '400'}
            bg={category === item.id ? 'rgba(233,196,106,0.10)' : 'transparent'} borderRadius="md" px="3" minH="38px"
            _hover={{ bg: 'rgba(255,255,255,0.05)', color: 'kk.textPrimary' }}>
            {item.label}
          </Button>)}
        </Flex>
      </Box>
      <Box key={category} flex="1" minW="0" overflowY="auto" p={{ base: '4', md: '6' }} pb="12" aria-labelledby="settings-page-title">
        <Box mb="5"><Text as="h2" id="settings-page-title" fontSize="xl" fontWeight="600" color="kk.textPrimary">{page.label}</Text>
          <Text fontSize="sm" color="kk.textSecondary" mt="1">{page.description}</Text></Box>
        <VStack gap="4" align="stretch">{children}</VStack>
      </Box>
    </Flex>
  </SettingsCategoryContext.Provider>
}
