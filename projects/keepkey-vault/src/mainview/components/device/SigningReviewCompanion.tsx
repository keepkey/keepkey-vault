import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Box, Button, Flex, Text, VStack } from '@chakra-ui/react'
import type { SigningRequestInfo } from '../../../shared/types'
import { emulatorReviewPixels, signingReviewGuide, type SigningRequestKind, type SigningReviewDepth } from '../../../shared/signing-review-guide'
import { NumberNode, PreflightList, PreflightStyles, TimelineItem, TimelineMark, usePreflightShort } from '../preflight/PreflightConsole'
import { OledConfirm, OledText, SpinningDevice } from '../v3'
import { hiveDeviceMirror, mirrorPosition, type DeviceMirror } from '../../../shared/hive-device-screens'
import { ethSignTxMirror, ethTxFromBody } from '../../../shared/eth-device-screens'
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

/** The KeepKey's own screens for this request, when Desktop can compute them
 *  from the firmware (shared/hive-device-screens): one screen per device
 *  ButtonRequest, following the device as the requests arrive. Null when the
 *  request type has no mirror; the caller then shows its sketch. */
export function useDeviceMirror(request: SigningRequestInfo) {
  return useMemo(() => deviceMirrorFor(request), [request])
}

/** Hive requests, and EthereumSignTx (shared/eth-device-screens) unless a
 *  ClearSign description goes to the device: then its own screens show. */
export function deviceMirrorFor(request: SigningRequestInfo): DeviceMirror | null {
  if (request.method === '/eth/sign-transaction') {
    const descriptor = request.clearSignReport?.descriptor
    const clearSign = !!request.certifiedEvmSchema || !!request.erc7730
      || (!!descriptor?.authenticated && (descriptor.format === 'ERC7730' || descriptor.format === 'EVM_METADATA'))
    const tx = ethTxFromBody(request.rawRequestBody, { chainId: request.chainId, advancedMode: request.advancedModeEnabled, clearSign })
    return tx && ethSignTxMirror(tx)
  }
  return hiveDeviceMirror(request.method, request.rawRequestBody)
}

export function DeviceMirrorPanel({ request, mirror: given, devicePrompts = 0, following = false, scale = 1 }: {
  request?: SigningRequestInfo
  /** A mirror computed by the caller (the swap's own transaction), instead of the request's. */
  mirror?: DeviceMirror | null
  devicePrompts?: number
  /** True while the device is reviewing: the shown screen tracks its ButtonRequests. */
  following?: boolean
  scale?: number
}) {
  const uiText = useUiTranslation()
  const fromRequest = useMemo(() => request ? deviceMirrorFor(request) : null, [request])
  const mirror = given !== undefined ? given : fromRequest
  const [pinned, setPinned] = useState<number | null>(null)
  // Each ButtonRequest means the device moved on: stop peeking and follow it.
  useEffect(() => { setPinned(null) }, [devicePrompts])
  if (!mirror) return null
  const total = mirror.screens.length
  if (!total) return <p className="kk-pf-detail" data-device-mirror="refused">{mirror.reason}</p>
  const position = following && devicePrompts > 0 ? mirrorPosition(mirror, devicePrompts) : null
  const live = position?.to ?? 0
  const at = Math.min(pinned ?? live, total - 1)
  const onDevice = (i: number) => !!position && !position.beyond && i >= position.from && i <= position.to
  const screen = mirror.screens[at]!
  const recipient = typeof request?.rawRequestBody?.to === 'string' ? request.rawRequestBody.to : undefined
  const contactNote = mirror.mayPrepend === 'contact-address'
    ? uiText('If the recipient is a certified contact on your KeepKey, its name replaces the address and a “Contact Address” screen follows.')
    : recipient
      ? uiText('If @{{account}} is a certified contact on your KeepKey, it shows a “Certified contact” screen first.', { account: recipient })
      : uiText('If a recipient is a certified contact on your KeepKey, it shows a “Certified contact” screen first.')
  return <div data-device-mirror={mirror.exact ? 'exact' : 'approximate'} style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
    <SpinningDevice motion="still" scale={scale} label={`${screen.title}. ${screen.rows.join(' ')}`} screen={<OledConfirm title={screen.title} rows={screen.rows} />} />
    {total > 1 && <div className="kk-pf-modes" role="group" aria-label={uiText('KeepKey screens')} style={{ flexWrap: 'wrap' }}>
      {mirror.screens.map((s, i) => <button key={i} type="button" aria-pressed={i === at} aria-current={onDevice(i) ? 'step' : undefined}
        title={s.title} onClick={() => setPinned(position && i === live ? null : i)}>{i + 1}</button>)}
    </div>}
    <p className="kk-pf-detail" style={{ margin: 0 }}>
      {mirror.exact
        ? position && pinned === null
          ? position.beyond
            ? uiText('Your KeepKey asked for more confirmations than these {{total}} screens. Trust its own screen.', { total })
            : position.from < position.to
              ? uiText('Screen {{from}}–{{to}} of {{total}}: your KeepKey is on one of these now.', { from: position.from + 1, to: position.to + 1, total })
              : uiText('Screen {{n}} of {{total}}, as your KeepKey shows it now.', { n: at + 1, total })
          : uiText('Screen {{n}} of {{total}}, exactly as your KeepKey firmware draws it.', { n: at + 1, total })
        : <>{mirror.reason} {uiText('Screens after this point are approximate. Trust your KeepKey’s own screen.')}</>}
    </p>
    {mirror.mayPrepend && <p className="kk-pf-detail" style={{ margin: 0 }}>{contactNote}</p>}
  </div>
}

const KIND_OLED: Record<SigningRequestKind, string> = {
  message: 'SIGN MESSAGE', typed: 'SIGN TYPED DATA', contract: 'CONTRACT CALL', transaction: 'SIGN TRANSACTION',
}

/** The KeepKey for requests Desktop cannot draw screen by screen: the large
 *  still device with a sketch of the request, and one mark per confirmation
 *  the device has asked for so far (its ButtonRequests). */
export function DeviceSketchPanel({ request, devicePrompts = 0, following = false, scale = 1 }: {
  request: SigningRequestInfo; devicePrompts?: number; following?: boolean; scale?: number
}) {
  const uiText = useUiTranslation()
  const guide = signingReviewGuide(request)
  const account = guide.fields.find(f => f.label === 'Account')?.value
  const network = guide.fields.find(f => f.label === 'Network')?.value
  const short = (v?: string) => v && v.length > 18 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v
  const seen = following ? devicePrompts : 0
  return <div data-device-sketch style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
    <SpinningDevice motion="still" scale={scale} label={`${KIND_OLED[guide.kind]} ${account ?? ''}`.trim()}
      screen={<OledText kicker={KIND_OLED[guide.kind]} headline={short(account)} sub={network} />} />
    {seen > 0 && <div className="kk-pf-modes" role="list" aria-label={uiText('Confirmations so far')} style={{ flexWrap: 'wrap' }}>
      {Array.from({ length: seen }, (_, i) => <span key={i} role="listitem" aria-current={i === seen - 1 ? 'step' : undefined}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 11, padding: '2px 0', color: i === seen - 1 ? 'var(--text-0)' : 'var(--text-2)',
          borderBottom: `1px solid ${i === seen - 1 ? 'var(--gold)' : 'transparent'}` }}>{i + 1}</span>)}
    </div>}
    <p className="kk-pf-note">
      {seen > 0 && <>{uiText('Confirmation {{n}} on your KeepKey.', { n: seen })}{' '}</>}
      {uiText('A sketch, not a readback. Trust your KeepKey’s own screen.')}
    </p>
  </div>
}

/** The KeepKey for the signing console's left column: the firmware-exact
 *  screens when Desktop can compute them, the sketch otherwise. */
export function SigningDevicePanel(props: { request: SigningRequestInfo; devicePrompts?: number; following?: boolean; scale?: number }) {
  const mirror = useDeviceMirror(props.request)
  return mirror ? <DeviceMirrorPanel key={props.request.id} {...props} /> : <DeviceSketchPanel {...props} />
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
export function SigningReviewCompanion({ request, phase = 'preview', devicePrompts = 0, showModes = true, showWarnings = true, showDevice = true, technical }: {
  request: SigningRequestInfo; phase?: 'preview' | 'approve' | 'sending-payload' | 'device-confirm'; devicePrompts?: number
  /** False when the device is drawn elsewhere (the confirm phase's left column). */
  showDevice?: boolean
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
  const account = guide.fields.find(f => f.label === 'Account')?.value
  const network = guide.fields.find(f => f.label === 'Network')?.value
  const short = (v?: string) => v && v.length > 18 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v
  const steps = preferences.depth === 'essentials' && guide.steps.length > 3
    ? [guide.steps[0]!, guide.steps[1]!, guide.steps[guide.steps.length - 1]!]
    : guide.steps
  const liveEmulator = phase === 'device-confirm' && !!request.deviceReview?.emulator
  const mirror = useDeviceMirror(request)
  // In a short window the step guide folds to one line; the user opens it.
  const fold = usePreflightShort()
  const stepItems = steps.map((step, i) => <TimelineItem key={step.title} node={<NumberNode n={i + 1} gold={i === steps.length - 1} />} title={uiText(step.title)}>
    {preferences.depth === 'audit' && <>{uiText(step.why)}{' '}</>}{uiText(step.compare)}
  </TimelineItem>)
  const guideAttrs = preferences.depth === 'essentials' ? { 'data-screen-steps': '' } : { 'data-screen-guide': '' }
  return <VStack align="stretch" gap="5" w="100%" textAlign="left" data-signing-review-depth={preferences.depth}>
    <PreflightStyles />
    {showModes && <SigningReviewModes />}
    {liveEmulator
      ? <PairedEmulatorDisplay key={`${request.id}:${request.deviceReview!.deviceId}`} request={request} />
      : !showDevice ? null
      // Firmware-exact screens when Desktop can compute them; a sketch otherwise.
      : mirror ? <DeviceMirrorPanel key={request.id} request={request} scale={0.66} />
      // What to confirm must be readable: the device never turns here.
      : <div className="kk-pf-device">
        <SpinningDevice motion="still" scale={0.66} screen={<OledText kicker={KIND_OLED[guide.kind]} headline={short(account)} sub={network} />} />
        <div className="kk-pf-cap">{uiText('A sketch, not a readback. Trust your KeepKey’s own screen.')}</div>
      </div>}
    {phase === 'device-confirm' && !request.deviceReview?.emulator && !mirror?.exact && <Box>
      <Text fontSize={font} color="var(--text-0)" fontWeight="600">{uiText('Compare with your KeepKey')}</Text>
      <Text fontSize={font} color="var(--text-1)" lineHeight="1.6">{uiText('Use the physical screen to make your final decision. The app’s guide is a reference, not a readback of that screen.')}</Text>
    </Box>}
    {showWarnings && guide.warnings.length > 0 && <PreflightList rows={guide.warnings.map(w => ({ key: w, status: 'warn' as const, title: uiText(w), attrs: { 'data-review-warning': '' } }))} />}
    {/* With the KeepKey in the left column, its marks already count these. */}
    {devicePrompts > 0 && showDevice && <Text fontSize="12px" color="var(--text-2)">{uiText('Device confirmation requests: {{count}}', { count: devicePrompts })}</Text>}
    {/* Simple shows the three essential steps; Guided/Audit the full screen guide. */}
    {fold
      ? <details className="kk-pf-tech kk-pf-fold" data-guide-fold>
        <summary>{uiText('On your KeepKey')}<small className="kk-pf-dim">{steps.length}</small></summary>
        <div className="kk-pf-tl" {...guideAttrs}>{stepItems}</div>
      </details>
      : <div className="kk-pf-tl" {...guideAttrs}>
        <TimelineMark big={uiText('On your KeepKey')} />
        {stepItems}
      </div>}
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
    <p className="kk-pf-note">{uiText('These choices change the app’s explanations and text size. Your KeepKey still requires its full device review.')}</p>
  </VStack>
}
