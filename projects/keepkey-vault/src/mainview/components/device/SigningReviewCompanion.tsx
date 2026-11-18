import { useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Text, VStack } from '@chakra-ui/react'
import type { SigningRequestInfo } from '../../../shared/types'
import { emulatorReviewPixels, signingReviewGuide, type SigningReviewDepth } from '../../../shared/signing-review-guide'
import { useUiTranslation } from '../../i18n/ui'
import { useSigningReviewPreferences } from '../../lib/signing-review-preferences'
import { rpcRequest } from '../../lib/rpc'

export function PairedEmulatorDisplay({ request }: { request: SigningRequestInfo }) {
  const uiText = useUiTranslation()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [frame, setFrame] = useState<string | null>(null)
  const [scale, setScale] = useState(3)
  const deviceId = request.deviceReview?.deviceId
  useEffect(() => {
    if (!request.deviceReview?.emulator || !deviceId) return
    let stopped = false, busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        const value = await rpcRequest<{ frame: string; deviceId: string } | null>('signingReviewFrame', { signingId: request.id, deviceId }, 2000)
        if (!stopped) setFrame(value?.deviceId === deviceId ? value.frame : null)
      } catch { if (!stopped) setFrame(null) }
      finally { busy = false }
    }
    void tick(); const timer = setInterval(tick, 200)
    return () => { stopped = true; clearInterval(timer) }
  }, [request.id, request.deviceReview?.emulator, deviceId])
  useEffect(() => {
    if (!frame || !canvas.current) return
    try {
      const pixels = emulatorReviewPixels(Uint8Array.from(atob(frame), c => c.charCodeAt(0)))
      const context = canvas.current.getContext('2d')
      if (context) { const image = context.createImageData(256, 64); image.data.set(pixels); context.putImageData(image, 0, 0) }
    } catch { setFrame(null) }
  }, [frame])
  if (!request.deviceReview?.emulator || !deviceId) return null
  return <VStack align="stretch" gap="2" w="100%" data-live-emulator-review>
    <Flex align="center" justify="space-between" wrap="wrap" gap="2">
      <Text fontSize="sm" fontWeight="700" color="kk.textPrimary">{uiText('Live emulator screen')}</Text>
      <Flex gap="1" role="group" aria-label={uiText('Display scale')}>
        {[2, 3, 4].map(value => <Button key={value} size="xs" variant={scale === value ? 'solid' : 'ghost'} aria-pressed={scale === value} onClick={() => setScale(value)}>{value}×</Button>)}
      </Flex>
    </Flex>
    {frame ? <Box overflowX="auto" w="100%" bg="#0f1319" borderRadius="lg" p="2">
      <canvas ref={canvas} width={256} height={64} aria-label={uiText('Actual pixels captured from the active emulator')} style={{ display: 'block', width: 256 * scale, height: 64 * scale, imageRendering: 'pixelated', maxWidth: 'none' }} />
    </Box> : <Text fontSize="sm" color="kk.textSecondary" role="status">{uiText('Waiting for this signing request’s emulator screen…')}</Text>}
    <Text fontSize="xs" color="kk.textSecondary">{uiText('This is the emulator’s captured display. Confirm or reject in its device window.')}</Text>
  </VStack>
}

export function SigningReviewCompanion({ request, phase = 'preview', devicePrompts = 0 }: {
  request: SigningRequestInfo; phase?: 'preview' | 'approve' | 'sending-payload' | 'device-confirm'; devicePrompts?: number
}) {
  const uiText = useUiTranslation()
  const [preferences, update] = useSigningReviewPreferences()
  const guide = signingReviewGuide(request)
  const [openStep, setOpenStep] = useState(0)
  const font = preferences.largeText ? '17px' : '15px'
  const labels: Record<SigningReviewDepth, string> = { essentials: uiText('Essentials'), guided: uiText('Guided'), audit: uiText('Deep audit') }
  return <VStack align="stretch" gap="4" w="100%" textAlign="left" fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" css={{ '& button': { fontFamily: 'inherit' } }} data-signing-review-depth={preferences.depth}>
    <Flex justify="space-between" align="center" wrap="wrap" gap="2">
      <Flex gap="1" role="group" aria-label={uiText('Review detail')}>
        {(['essentials', 'guided', 'audit'] as const).map(depth => <Button key={depth} size="sm" variant={preferences.depth === depth ? 'solid' : 'outline'} aria-pressed={preferences.depth === depth} onClick={() => update({ depth })}>{labels[depth]}</Button>)}
      </Flex>
      <Button size="sm" variant="ghost" aria-pressed={preferences.largeText} onClick={() => update({ largeText: !preferences.largeText })}>{uiText('Larger text')}</Button>
    </Flex>
    <Box>
      <Text fontSize="lg" fontWeight="700" color="kk.textPrimary">{uiText(guide.title)}</Text>
      <Text fontSize={font} lineHeight="1.65" color="kk.textSecondary" mt="1">{uiText(guide.purpose)}</Text>
    </Box>
    {guide.warnings.map(warning => <Box key={warning} borderLeft="3px solid" borderColor="orange.300" pl="3" role="note" data-review-warning>
      <Text fontSize={font} lineHeight="1.65" color="kk.textPrimary">{uiText(warning)}</Text>
    </Box>)}
    {phase === 'device-confirm' && request.deviceReview?.emulator && <PairedEmulatorDisplay key={`${request.id}:${request.deviceReview.deviceId}`} request={request} />}
    {phase === 'device-confirm' && !request.deviceReview?.emulator && <Box bg="rgba(233,196,106,0.06)" borderRadius="lg" p="3">
      <Text fontSize={font} color="kk.textPrimary" fontWeight="600">{uiText('Compare with your KeepKey')}</Text>
      <Text fontSize={font} color="kk.textSecondary" lineHeight="1.65">{uiText('Use the physical screen to make your final decision. The app’s guide is a reference, not a readback of that screen.')}</Text>
    </Box>}
    {devicePrompts > 0 && <Text fontSize="sm" color="kk.textSecondary">{uiText('Device confirmation requests: {{count}}', { count: devicePrompts })}</Text>}
    <VStack gap="3" align="stretch">
      {guide.fields.map((field, i) => <Box key={`${field.label}:${i}`}>
        <Text fontSize="sm" fontWeight="600" color="kk.textSecondary">{uiText(field.label)}</Text>
        <Text fontSize={font} lineHeight="1.65" color="kk.textPrimary" whiteSpace="pre-wrap" overflowWrap="anywhere" css={{ unicodeBidi: 'plaintext' }}>{field.value}</Text>
      </Box>)}
    </VStack>
    {preferences.depth !== 'essentials' && <VStack align="stretch" gap="2" data-screen-guide>
      <Text fontSize="md" fontWeight="700" color="kk.textPrimary">{uiText('Screen guide')}</Text>
      <Text fontSize="sm" lineHeight="1.6" color="kk.textSecondary">{uiText('Choose the part you are reviewing. Device screens and their order can vary with the request and firmware.')}</Text>
      {guide.steps.map((step, i) => <Box key={step.title} border="1px solid" borderColor="kk.border" borderRadius="lg" overflow="hidden">
        <Button variant="ghost" w="100%" justifyContent="flex-start" whiteSpace="normal" height="auto" py="3" textAlign="left" aria-expanded={openStep === i} onClick={() => setOpenStep(openStep === i ? -1 : i)}>{i + 1}. {uiText(step.title)}</Button>
        {openStep === i && <VStack p="3" pt="0" align="stretch" gap="2">
          <Text fontSize={font} lineHeight="1.65" color="kk.textSecondary">{uiText(step.why)}</Text>
          <Text fontSize={font} lineHeight="1.65" color="kk.textPrimary">{uiText(step.compare)}</Text>
        </VStack>}
      </Box>)}
    </VStack>}
    {preferences.depth === 'audit' && <Box>
      <Text fontSize="md" fontWeight="700" mb="2" color="kk.textPrimary">{uiText('Raw signing reference')}</Text>
      {guide.raw ? <Box as="pre" fontFamily="mono" fontSize={preferences.largeText ? '15px' : '13px'} lineHeight="1.65" whiteSpace="pre-wrap" overflowWrap="anywhere" bg="rgba(0,0,0,0.22)" p="3" borderRadius="lg" maxH="320px" overflowY="auto" color="kk.textPrimary">{guide.raw}</Box>
        : <Text fontSize={font} lineHeight="1.65" color="kk.textSecondary">{uiText('A public byte reference is not supplied for this request. Compare the signed fields and the device review.')}</Text>}
    </Box>}
    <Text fontSize="sm" color="kk.textSecondary" lineHeight="1.6">{uiText('These choices change the app’s explanations and text size. Your KeepKey still requires its full device review.')}</Text>
  </VStack>
}
