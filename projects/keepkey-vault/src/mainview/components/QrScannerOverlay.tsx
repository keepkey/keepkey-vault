import { useState, useEffect, useRef, useCallback } from "react"
import { createPortal } from "react-dom"
import { Box, Flex, Text, Button } from "@chakra-ui/react"
import jsQR from "jsqr"

interface QrScannerOverlayProps {
  onScan: (data: string) => void
  onClose: () => void
  /** Return false while collecting an animated sequence. Throw to show an error. */
  onFrame?: (data: string) => boolean
  onReset?: () => void
  status?: string
  title?: string
  initialImages?: File[]
}

async function decodeImage(file: Blob): Promise<string | null> {
  if (file.size > 20 * 1024 * 1024) throw new Error("QR image exceeds 20 MB")
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error("Could not read this QR image"))
      img.src = url
    })
    if (!img.width || !img.height || img.width * img.height > 16_000_000) throw new Error("QR image exceeds 16 megapixels")
    const canvas = document.createElement("canvas")
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) throw new Error("Image scanning is unavailable")
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
    return jsQR(data.data, data.width, data.height)?.data ?? null
  } finally { URL.revokeObjectURL(url) }
}

/** One frame for addresses/WalletConnect; continuing frames for Bitcoin UR/BBQr.
 * Images and camera frames are decoded locally. Camera tracks always stop on exit. */
export function QrScannerOverlay({ onScan, onClose, onFrame, onReset, status, title = "Scan QR Code", initialImages }: QrScannerOverlayProps) {
  const [mode, setMode] = useState<"starting" | "streaming" | "images">(initialImages?.length ? "images" : "starting")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [cameraAttempt, setCameraAttempt] = useState(0)
  const video = useRef<HTMLVideoElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const done = useRef(false)
  const mounted = useRef(true)
  const imagesBusy = useRef(false)
  const callbacks = useRef({ onScan, onClose, onFrame })
  callbacks.current = { onScan, onClose, onFrame }
  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    stream.current?.getTracks().forEach(t => t.stop())
    stream.current = null
  }, [])
  const accept = useCallback((data: string) => {
    if (done.current || !mounted.current) return false
    try {
      const complete = callbacks.current.onFrame ? callbacks.current.onFrame(data) : true
      setError(null)
      if (complete) {
        done.current = true
        stop()
        if (!callbacks.current.onFrame) callbacks.current.onScan(data)
      }
      return complete
    } catch (e: any) { setError(e?.message || "Could not decode QR"); return false }
  }, [stop])
  const processImages = useCallback(async (files: File[]) => {
    if (imagesBusy.current || done.current) return
    imagesBusy.current = true
    setLoading(true)
    setError(null)
    try {
      if (files.length > 4096) throw new Error("Select at most 4096 QR frame images")
      for (const file of files) {
        if (!mounted.current || done.current) break
        const data = await decodeImage(file)
        if (!mounted.current) break
        if (!data) throw new Error("No QR found. Use a clearer image, or select all frames of the animation.")
        if (accept(data)) break
      }
    } catch (e: any) { if (mounted.current) setError(e?.message || "Image scan failed") }
    finally { imagesBusy.current = false; if (mounted.current) setLoading(false) }
  }, [accept])
  useEffect(() => {
    mounted.current = true
    done.current = false
    if (initialImages?.length) void processImages(initialImages)
    return () => { mounted.current = false; done.current = true; stop() }
    // Initial images belong to this scanner session only.
  }, [stop, processImages, initialImages])
  useEffect(() => {
    if (mode === "images") return
    let cancelled = false
    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera unavailable")
        const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
        if (cancelled || done.current) { camera.getTracks().forEach(t => t.stop()); return }
        stream.current = camera
        if (video.current) { video.current.srcObject = camera; await video.current.play() }
        if (cancelled || done.current) { stop(); return }
        setMode("streaming")
        const canvas = document.createElement("canvas")
        const ctx = canvas.getContext("2d", { willReadFrequently: true })
        if (!ctx) throw new Error("Camera image scanning is unavailable")
        timer.current = setInterval(() => {
          const v = video.current
          if (done.current || imagesBusy.current || !v || v.readyState < 2 || !v.videoWidth) return
          const scale = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight))
          canvas.width = Math.round(v.videoWidth * scale)
          canvas.height = Math.round(v.videoHeight * scale)
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
          const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const code = jsQR(frame.data, frame.width, frame.height)
          if (code?.data) accept(code.data)
        }, 120)
      } catch {
        if (!cancelled) { stop(); setError("Camera unavailable. Choose QR image files instead, or retry the camera."); setMode("images") }
      }
    }
    void start()
    return () => { cancelled = true; stop() }
    // Changing starting -> streaming must not restart the camera.
  }, [cameraAttempt, mode === "images", accept, stop])

  const close = () => { done.current = true; stop(); callbacks.current.onClose() }
  return createPortal(
    <Flex position="fixed" inset={0} bg="blackAlpha.900" zIndex={2000} align="center" justify="center" direction="column" overflowY="auto" py="5" gap="3" role="dialog" aria-modal="true" aria-label={title}>
      <Text color="white" fontSize="lg" fontWeight="bold">{title}</Text>
      {mode !== "images" && <Box w="90%" maxW="560px" bg="black" border="1px solid" borderColor="kk.gold" borderRadius="lg" overflow="hidden">
        {mode === "starting" && <Text p="5" color="gray.400">Starting camera…</Text>}
        <video ref={video} playsInline muted style={{ width: "100%", display: mode === "streaming" ? "block" : "none" }} />
      </Box>}
      <Text color="gray.300" fontSize="sm" textAlign="center" maxW="90%" role="status">{loading ? "Reading QR images…" : status || "Point the camera at a QR code. Keep animated codes playing until all frames arrive."}</Text>
      {error && <Text color="red.300" fontSize="sm" maxW="90%" textAlign="center" role="alert">{error}</Text>}
      <Box border="1px dashed" borderColor="gray.500" p="4" borderRadius="lg" color="gray.300" cursor="pointer" maxW="90%"
        onClick={() => input.current?.click()}
        onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); void processImages(Array.from(e.dataTransfer.files)) }}>
        Choose or drop QR images (select all frames for animated codes)
      </Box>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/bmp" multiple style={{ display: "none" }} onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void processImages(files) }} />
      <Flex gap="2" wrap="wrap" justify="center">
        {mode === "images" ? <Button size="sm" bg="gray.800" color="gray.200" onClick={() => { setError(null); setMode("starting"); setCameraAttempt(n => n + 1) }}>Retry camera</Button>
          : <Button size="sm" bg="gray.800" color="gray.200" onClick={() => { stop(); setMode("images") }}>Stop camera</Button>}
        {onReset && <Button size="sm" bg="gray.800" color="gray.200" disabled={loading} onClick={() => { done.current = false; onReset(); setError(null) }}>Reset scan</Button>}
        <Button size="sm" bg="gray.800" color="gray.200" onClick={close}>Cancel</Button>
      </Flex>
    </Flex>, document.body)
}
