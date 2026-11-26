import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Box, Button, Flex, Text, VStack } from '@chakra-ui/react'
import type { SigningRequestInfo } from '../../../shared/types'
import { emulatorReviewPixels, signingReviewGuide, type SigningRequestKind, type SigningReviewDepth } from '../../../shared/signing-review-guide'
import { NumberNode, PreflightList, PreflightStyles, TimelineItem, TimelineMark } from '../preflight/PreflightConsole'
import { OledText, SpinningDevice } from '../v3'
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

const KIND_OLED: Record<SigningRequestKind, string> = {
  message: 'SIGN MESSAGE', typed: 'SIGN TYPED DATA', contract: 'CONTRACT CALL', transaction: 'SIGN TRANSACTION',
}

/** Simple / Guided / Audit as text tabs, plus the larger-text toggle. */
export function SigningReviewModes() {
  const uiText = useUiTranslation()
  const [preferences, update] = useSigningReviewPreferences()
  const labels: Record<SigningReviewDepth, string> = { essentials: uiText('Simple'), guided: uiText('Guided'), audit: uiText('Audit') }
  return <div className="kk-pf-modes" role="group" aria-label={uiText('Review detail')}>
    {(['essentials', 'guided', 'audit'] as const).map(depth => <button key={depth} type="button" aria-pressed={preferences.depth === depth} onClick={() => update({ depth })}>{labels[depth]}</button>)}
    <button type="button" aria-pressed={preferences.largeText} onClick={() => update({ largeText: !preferences.largeText })}>{uiText('Larger text')}</button>
  </div>
}

/** Right column of the signing console: a sketch of the device, the steps to
 *  take on it, the request's fields and its technical reference. Advice for
 *  reading the request only — the KeepKey's own screen is what counts. */
export function SigningReviewCompanion({ request, phase = 'preview', devicePrompts = 0, showModes = true, showWarnings = true, technical }: {
  request: SigningRequestInfo; phase?: 'preview' | 'approve' | 'sending-payload' | 'device-confirm'; devicePrompts?: number
  /** Approve phase shows the modes in its own header. */
  showModes?: boolean
  /** Approve phase lists the warnings as preflight rows instead. */
  showWarnings?: boolean
  /** Extra reference material placed under "Technical details". */
  technical?: ReactNode
}) {
  const uiText = useUiTranslation()
  const [preferences] = useSigningReviewPreferences()
  const guide = signingReviewGuide(request)
  const font = preferences.largeText ? '17px' : '14px'
  const network = guide.fields.find(f => f.label === 'Network')?.value
  const steps = preferences.depth === 'essentials' && guide.steps.length > 3
    ? [guide.steps[0]!, guide.steps[1]!, guide.steps[guide.steps.length - 1]!]
    : guide.steps
  const liveEmulator = phase === 'device-confirm' && !!request.deviceReview?.emulator
  return <VStack align="stretch" gap="5" w="100%" textAlign="left" data-signing-review-depth={preferences.depth}>
    <PreflightStyles />
    {showModes && <SigningReviewModes />}
    {liveEmulator
      ? <PairedEmulatorDisplay key={`${request.id}:${request.deviceReview!.deviceId}`} request={request} />
      // What to confirm must be readable: the device never turns here.
      // No account in the sketch: a single-line OLED headline can't hold a full
      // address, and a shortened one must never be what the user compares.
      : <div className="kk-pf-device">
        <SpinningDevice motion="still" scale={0.66} screen={<OledText kicker={KIND_OLED[guide.kind]} headline={network} />} />
        <div className="kk-pf-cap">{uiText('A sketch, not a readback. Trust your KeepKey’s own screen.')}</div>
      </div>}
    {phase === 'device-confirm' && !request.deviceReview?.emulator && <Box>
      <Text fontSize={font} color="var(--text-0)" fontWeight="600">{uiText('Compare with your KeepKey')}</Text>
      <Text fontSize={font} color="var(--text-1)" lineHeight="1.6">{uiText('Use the physical screen to make your final decision. The app’s guide is a reference, not a readback of that screen.')}</Text>
    </Box>}
    {showWarnings && guide.warnings.length > 0 && <PreflightList rows={guide.warnings.map(w => ({ key: w, status: 'warn' as const, title: uiText(w), attrs: { 'data-review-warning': '' } }))} />}
    {devicePrompts > 0 && <Text fontSize="12px" color="var(--text-2)">{uiText('Device confirmation requests: {{count}}', { count: devicePrompts })}</Text>}
    {/* Simple shows the three essential steps; Guided/Audit the full screen guide. */}
    <div className="kk-pf-tl" {...(preferences.depth === 'essentials' ? { 'data-screen-steps': '' } : { 'data-screen-guide': '' })}>
      <TimelineMark big={uiText('On your KeepKey')} />
      {steps.map((step, i) => <TimelineItem key={step.title} node={<NumberNode n={i + 1} gold={i === steps.length - 1} />} title={uiText(step.title)}>
        {preferences.depth === 'audit' && <>{uiText(step.why)}{' '}</>}{uiText(step.compare)}
      </TimelineItem>)}
    </div>
    {guide.fields.length > 0 && <dl className="kk-pf-facts" style={{ fontSize: font }}>
      {guide.fields.map((field, i) => <div key={`${field.label}:${i}`}>
        <dt>{uiText(field.label)}</dt>
        <dd style={{ whiteSpace: 'pre-wrap', unicodeBidi: 'plaintext' }}>{field.value}</dd>
      </div>)}
    </dl>}
    <details className="kk-pf-tech" open={preferences.depth === 'audit'}>
      <summary>{uiText('Technical details')}</summary>
      <VStack align="stretch" gap="3" mt="3">
        <Text fontSize="12px" fontFamily="var(--font-mono)" color="var(--text-1)">{request.method}</Text>
        <Box>
          <Text fontSize="12px" fontWeight="600" mb="1" color="var(--text-1)">{uiText('Raw signing reference')}</Text>
          {guide.raw ? <Box as="pre" fontFamily="var(--font-mono)" fontSize={preferences.largeText ? '15px' : '12px'} lineHeight="1.6" whiteSpace="pre-wrap" overflowWrap="anywhere" bg="rgba(0,0,0,0.28)" p="3" borderRadius="md" maxH="320px" overflowY="auto" color="var(--text-0)">{guide.raw}</Box>
            : <Text fontSize="12px" lineHeight="1.6" color="var(--text-1)">{uiText('A public byte reference is not supplied for this request. Compare the signed fields and the device review.')}</Text>}
        </Box>
        {technical}
      </VStack>
    </details>
    <Text fontSize="11px" color="var(--text-2)" lineHeight="1.5">{uiText('These choices change the app’s explanations and text size. Your KeepKey still requires its full device review.')}</Text>
  </VStack>
}
