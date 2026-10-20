import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Box, Flex, Text, Button } from '@chakra-ui/react'
import { bitcoinQrFrames, type BitcoinQrFormat } from '../../shared/bitcoin-qr'
import { generateQRSvg } from '../lib/qr'

/** Public transaction/account transport only. There are no remote QR services. */
export function BitcoinQrDialog({ bytes, title, onClose }: { bytes: Uint8Array; title: string; onClose: () => void }) {
  const [format, setFormat] = useState<BitcoinQrFormat>('ur')
  const [fragmentSize, setFragmentSize] = useState(200)
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [interval, setIntervalMs] = useState(300)
  const [copied, setCopied] = useState(false)
  const encoded = useMemo(() => {
    try { return { frames: bitcoinQrFrames(bytes, format, fragmentSize), error: '' } }
    catch (e: any) { return { frames: [] as string[], error: e?.message || 'Could not encode QR' } }
  }, [bytes, format, fragmentSize])
  const frames = encoded.frames
  const frame = frames[index % Math.max(frames.length, 1)]
  const rendered = useMemo(() => {
    try { return { svg: frame ? generateQRSvg(frame) : '', error: '' } }
    catch { return { svg: '', error: 'Too much data for one QR. Choose animated UR or BBQr.' } }
  }, [frame])
  useEffect(() => { setIndex(0); setCopied(false) }, [format, fragmentSize, bytes])
  useEffect(() => {
    if (paused || frames.length <= 1) return
    const timer = setInterval(() => setIndex(i => (i + 1) % frames.length), interval)
    return () => clearInterval(timer)
  }, [paused, frames.length, interval])
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return createPortal(
    <Flex position="fixed" inset={0} bg="blackAlpha.900" zIndex={2000} align="center" justify="center" direction="column" gap="3" overflowY="auto" py="4" role="dialog" aria-modal="true" aria-label={title}>
      <Text color="white" fontWeight="bold" fontSize="lg">{title}</Text>
      <Flex gap="2" wrap="wrap" justify="center">
        {(['ur', 'bbqr', 'electrum'] as const).map(f => <Button key={f} size="sm" bg={format === f ? '#e9c46a' : '#222'} color={format === f ? '#000' : '#eee'} onClick={() => setFormat(f)}>{f === 'ur' ? 'UR (Sparrow)' : f === 'bbqr' ? 'BBQr (Sparrow)' : 'Static (Electrum)'}</Button>)}
      </Flex>
      {(encoded.error || rendered.error) && <Text color="red.300" maxW="90%" textAlign="center" role="alert">{encoded.error || rendered.error}</Text>}
      {rendered.svg && <Box bg="white" flexShrink={0} w="min(68vh, 85vw, 640px)" aspectRatio={1} css={{ '& svg': { width: '100%', height: '100%', display: 'block' } }} dangerouslySetInnerHTML={{ __html: rendered.svg }} />}
      <Text color="gray.300" fontSize="sm" textAlign="center" maxW="90%">{frames.length > 1 ? `Frame ${index % frames.length + 1} of ${frames.length} · Keep scanning until complete` : 'Single QR code'}</Text>
      <Text color="gray.400" fontSize="xs" textAlign="center" maxW="90%">{format === 'electrum' ? 'Electrum uses a static Base43 QR. Large transactions need animated UR or BBQr.' : 'Scan with the receiving wallet. QR transfer works without a network connection.'} Public wallet metadata reveals account activity to its recipient.</Text>
      {format !== 'electrum' && <Flex gap="2" wrap="wrap" justify="center">
        <label style={{ color: '#ccc', fontSize: 12 }}>Density <select aria-label="QR density" value={fragmentSize} onChange={e => setFragmentSize(Number(e.target.value))} style={{ color: '#111', marginLeft: 6 }}>
          <option value={100}>Low</option><option value={200}>Medium</option><option value={400}>High</option>
        </select></label>
        <label style={{ color: '#ccc', fontSize: 12 }}>Speed <select aria-label="QR speed" value={interval} onChange={e => setIntervalMs(Number(e.target.value))} style={{ color: '#111', marginLeft: 6 }}>
          <option value={500}>Slow</option><option value={300}>Normal</option><option value={150}>Fast</option>
        </select></label>
      </Flex>}
      <Flex gap="2" justify="center" wrap="wrap">
        {frames.length > 1 && <>
          <Button size="sm" bg="gray.800" color="gray.200" onClick={() => setPaused(p => !p)}>{paused ? 'Play' : 'Pause'}</Button>
          <Button size="sm" bg="gray.800" color="gray.200" onClick={() => { setPaused(true); setIndex(i => (i + 1) % frames.length) }}>Next frame</Button>
        </>}
        {frame && <Button size="sm" bg="gray.800" color="gray.200" onClick={() => { setPaused(true); navigator.clipboard.writeText(frame).then(() => setCopied(true)).catch(() => setCopied(false)) }}>{copied ? 'Copied frame' : 'Copy frame'}</Button>}
        <Button size="sm" bg="gray.800" color="gray.200" onClick={onClose}>Close</Button>
      </Flex>
    </Flex>, document.body)
}
