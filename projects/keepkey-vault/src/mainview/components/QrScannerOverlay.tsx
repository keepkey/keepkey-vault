import { useState, useEffect, useRef, useCallback } from "react"
import { Box, Flex, Text, Button } from "@chakra-ui/react"
import jsQR from "jsqr"

interface QrScannerOverlayProps {
	onScan: (data: string) => void
	onClose: () => void
}

type ScanMode = "starting" | "streaming" | "fallback"

function decodeQrFromBlob(blob: File | Blob): Promise<string | null> {
	return new Promise((resolve) => {
		const img = new Image()
		const url = URL.createObjectURL(blob)
		img.onload = () => {
			const canvas = document.createElement("canvas")
			canvas.width = img.width
			canvas.height = img.height
			const ctx = canvas.getContext("2d")
			if (!ctx) { URL.revokeObjectURL(url); resolve(null); return }
			ctx.drawImage(img, 0, 0)
			const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
			const code = jsQR(imageData.data, imageData.width, imageData.height)
			URL.revokeObjectURL(url)
			resolve(code?.data || null)
		}
		img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
		img.src = url
	})
}

export function QrScannerOverlay({ onScan, onClose }: QrScannerOverlayProps) {
	const [mode, setMode] = useState<ScanMode>("starting")
	const [error, setError] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const [dragOver, setDragOver] = useState(false)
	const videoRef = useRef<HTMLVideoElement>(null)
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const fileInputRef = useRef<HTMLInputElement>(null)
	const foundRef = useRef(false)
	const streamRef = useRef<MediaStream | null>(null)
	const scanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

	// Start browser camera on mount
	useEffect(() => {
		foundRef.current = false
		let cancelled = false

		async function startCamera() {
			try {
				const stream = await navigator.mediaDevices.getUserMedia({
					video: { facingMode: "environment", width: { ideal: 640 }, height: { ideal: 480 } },
					audio: false,
				})
				if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
				streamRef.current = stream
				if (videoRef.current) {
					videoRef.current.srcObject = stream
					videoRef.current.play().catch(() => {})
				}
				setMode("streaming")

				// Scan frames for QR codes at ~10fps
				scanIntervalRef.current = setInterval(() => {
					if (foundRef.current || !videoRef.current || !canvasRef.current) return
					const video = videoRef.current
					if (video.readyState < video.HAVE_ENOUGH_DATA) return

					const canvas = canvasRef.current
					canvas.width = video.videoWidth
					canvas.height = video.videoHeight
					const ctx = canvas.getContext("2d", { willReadFrequently: true })
					if (!ctx) return
					ctx.drawImage(video, 0, 0)
					const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
					const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" })
					if (code?.data) {
						foundRef.current = true
						onScan(code.data)
					}
				}, 100)
			} catch (err: any) {
				if (cancelled) return
				console.warn("[QrScanner] getUserMedia failed:", err.message)
				setError("Camera not available. Upload a QR code image instead.")
				setMode("fallback")
			}
		}

		startCamera()

		return () => {
			cancelled = true
			if (scanIntervalRef.current) clearInterval(scanIntervalRef.current)
			if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop())
		}
	}, [onScan])

	const handleClose = useCallback(() => {
		if (scanIntervalRef.current) clearInterval(scanIntervalRef.current)
		if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop())
		onClose()
	}, [onClose])

	// File upload fallback
	const processFile = useCallback(async (file: File | Blob) => {
		setLoading(true)
		setError(null)
		const result = await decodeQrFromBlob(file)
		setLoading(false)
		if (result) {
			onScan(result)
		} else {
			setError("No QR code found in image. Try a clearer photo.")
		}
	}, [onScan])

	const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0]
		if (file) processFile(file)
		e.target.value = ""
	}, [processFile])

	const handleDrop = useCallback((e: React.DragEvent) => {
		e.preventDefault()
		setDragOver(false)
		const file = e.dataTransfer.files?.[0]
		if (file && file.type.startsWith("image/")) {
			processFile(file)
		}
	}, [processFile])

	return (
		<Flex
			position="fixed"
			top={0} left={0}
			w="100vw" h="100vh"
			bg="blackAlpha.900"
			align="center" justify="center"
			zIndex={2000}
			direction="column"
		>
			<Text fontSize="lg" fontWeight="bold" color="white" mb="4">
				Scan QR Code
			</Text>

			{/* Live camera feed */}
			{(mode === "starting" || mode === "streaming") && (
				<>
					<Box
						position="relative"
						borderRadius="lg"
						overflow="hidden"
						border="2px solid"
						borderColor="kk.gold"
						maxW="400px"
						w="90%"
						bg="black"
					>
						{mode === "starting" && (
							<Flex align="center" justify="center" h="300px">
								<Text fontSize="sm" color="gray.500">Starting camera...</Text>
							</Flex>
						)}
						<video
							ref={videoRef}
							playsInline
							muted
							style={{
								width: "100%",
								display: mode === "streaming" ? "block" : "none",
								background: "#000",
							}}
						/>
						{/* Scan target overlay */}
						{mode === "streaming" && (
							<Box
								position="absolute" top="50%" left="50%"
								transform="translate(-50%, -50%)"
								w="60%" h="60%"
								border="2px solid rgba(255,215,0,0.5)"
								borderRadius="md"
								pointerEvents="none"
							/>
						)}
					</Box>
					<canvas ref={canvasRef} style={{ display: "none" }} />

					<Text fontSize="xs" color="gray.500" mt="3" textAlign="center">
						Point your camera at a wallet QR code
					</Text>

					{/* Switch to file upload */}
					<Button
						size="xs" variant="ghost" color="gray.600" mt="2"
						_hover={{ color: "gray.400" }}
						onClick={() => {
							if (scanIntervalRef.current) clearInterval(scanIntervalRef.current)
							if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop())
							setMode("fallback")
						}}
					>
						Use image file instead
					</Button>
				</>
			)}

			{/* File upload fallback */}
			{mode === "fallback" && (
				<>
					{error && (
						<Box mb="3" bg="rgba(255,23,68,0.1)" border="1px solid" borderColor="red.500" borderRadius="lg" p="3" maxW="360px" w="90%">
							<Text color="red.400" fontSize="xs" textAlign="center">{error}</Text>
						</Box>
					)}

					<Box
						w="90%" maxW="360px" h="180px"
						border="2px dashed"
						borderColor={dragOver ? "kk.gold" : "gray.600"}
						borderRadius="lg"
						bg={dragOver ? "rgba(255,215,0,0.06)" : "rgba(255,255,255,0.03)"}
						cursor="pointer"
						transition="all 0.15s"
						_hover={{ borderColor: "kk.gold", bg: "rgba(255,215,0,0.06)" }}
						onClick={() => fileInputRef.current?.click()}
						onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
						onDragLeave={() => setDragOver(false)}
						onDrop={handleDrop}
					>
						<Flex direction="column" align="center" justify="center" h="100%" gap="2" px="4">
							<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={dragOver ? "#FFD700" : "#888"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
								<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
								<polyline points="17 8 12 3 7 8" />
								<line x1="12" y1="3" x2="12" y2="15" />
							</svg>
							<Text fontSize="sm" color={dragOver ? "kk.gold" : "gray.400"} textAlign="center">
								{loading ? "Scanning..." : "Drop a QR code image here"}
							</Text>
							<Text fontSize="xs" color="gray.600" textAlign="center">
								or click to browse
							</Text>
						</Flex>
					</Box>

					<input
						ref={fileInputRef}
						type="file"
						accept="image/*"
						style={{ display: "none" }}
						onChange={handleFileChange}
					/>
				</>
			)}

			{/* Cancel */}
			<Button
				mt="4" size="sm"
				variant="outline"
				borderColor="gray.600"
				color="gray.300"
				_hover={{ borderColor: "red.400", color: "red.400" }}
				onClick={handleClose}
			>
				Cancel
			</Button>
		</Flex>
	)
}
