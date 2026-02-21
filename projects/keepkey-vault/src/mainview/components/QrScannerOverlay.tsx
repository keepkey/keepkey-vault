import { useState, useEffect, useRef, useCallback } from "react"
import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { getCameraStream, startScanning, stopStream } from "../lib/qr-scanner"
import { Z } from "../lib/z-index"

type ScanState = "requesting" | "scanning" | "error"

interface QrScannerOverlayProps {
	onDetect: (value: string) => void
	onClose: () => void
}

export function QrScannerOverlay({ onDetect, onClose }: QrScannerOverlayProps) {
	const videoRef = useRef<HTMLVideoElement>(null)
	const streamRef = useRef<MediaStream | null>(null)
	const cleanupRef = useRef<(() => void) | null>(null)
	const [state, setState] = useState<ScanState>("requesting")
	const [errorMsg, setErrorMsg] = useState("")

	const shutdown = useCallback(() => {
		cleanupRef.current?.()
		cleanupRef.current = null
		stopStream(streamRef.current)
		streamRef.current = null
	}, [])

	// Start camera on mount
	useEffect(() => {
		let cancelled = false

		getCameraStream()
			.then((stream) => {
				if (cancelled) { stopStream(stream); return }
				streamRef.current = stream
				const video = videoRef.current
				if (!video) { stopStream(stream); return }
				video.srcObject = stream
				video.play().catch(() => {})
				setState("scanning")

				// Start detection loop once video is playing
				const onPlaying = () => {
					if (cancelled) return
					cleanupRef.current = startScanning(
						video,
						(value) => {
							shutdown()
							onDetect(value)
						},
						(err) => {
							setState("error")
							setErrorMsg(err.message)
						},
					)
				}
				if (video.readyState >= video.HAVE_CURRENT_DATA) {
					onPlaying()
				} else {
					video.addEventListener("playing", onPlaying, { once: true })
				}
			})
			.catch((err: DOMException | Error) => {
				if (cancelled) return
				setState("error")
				if (err.name === "NotAllowedError") {
					setErrorMsg("Camera permission denied. Open System Settings > Privacy & Security > Camera to allow access.")
				} else if (err.name === "NotFoundError") {
					setErrorMsg("No camera found on this device.")
				} else if (err.name === "NotReadableError") {
					setErrorMsg("Camera is in use by another application.")
				} else {
					setErrorMsg(err.message || "Failed to access camera")
				}
			})

		return () => {
			cancelled = true
			shutdown()
		}
	}, []) // eslint-disable-line react-hooks/exhaustive-deps

	// Escape key to close
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") { shutdown(); onClose() }
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [onClose, shutdown])

	const handleBackdropClick = useCallback((e: React.MouseEvent) => {
		if (e.target === e.currentTarget) { shutdown(); onClose() }
	}, [onClose, shutdown])

	return (
		<Flex
			position="fixed"
			top={0}
			left={0}
			w="100vw"
			h="100vh"
			bg="blackAlpha.700"
			align="center"
			justify="center"
			zIndex={Z.dialog}
			onClick={handleBackdropClick}
		>
			<Box
				bg="gray.800"
				borderRadius="xl"
				border="1px solid"
				borderColor="gray.600"
				p="5"
				maxW="420px"
				w="90%"
				boxShadow="0 8px 32px rgba(0,0,0,0.6)"
			>
				<Text fontSize="lg" fontWeight="bold" mb="1" textAlign="center" color="white">
					Scan QR Code
				</Text>
				<Text color="gray.400" fontSize="xs" mb="4" textAlign="center">
					Hold a QR code in front of the camera
				</Text>

				{/* Camera viewport */}
				<Box
					position="relative"
					w="100%"
					bg="black"
					borderRadius="lg"
					overflow="hidden"
					mb="4"
					// 4:3 aspect ratio box
					_before={{
						content: '""',
						display: "block",
						pb: "75%",
					}}
				>
					<video
						ref={videoRef}
						autoPlay
						playsInline
						muted
						style={{
							position: "absolute",
							top: 0,
							left: 0,
							width: "100%",
							height: "100%",
							objectFit: "cover",
						}}
					/>

					{/* Scanning guide box */}
					{state === "scanning" && (
						<Box
							position="absolute"
							top="50%"
							left="50%"
							transform="translate(-50%, -50%)"
							w="55%"
							h="73%"
							border="2px solid"
							borderColor="kk.gold"
							borderRadius="lg"
							opacity={0.7}
							pointerEvents="none"
						/>
					)}

					{/* Requesting state */}
					{state === "requesting" && (
						<Flex
							position="absolute"
							top={0}
							left={0}
							w="100%"
							h="100%"
							align="center"
							justify="center"
						>
							<Text color="gray.400" fontSize="sm">Requesting camera...</Text>
						</Flex>
					)}

					{/* Error state */}
					{state === "error" && (
						<Flex
							position="absolute"
							top={0}
							left={0}
							w="100%"
							h="100%"
							align="center"
							justify="center"
							p="4"
						>
							<Text color="kk.error" fontSize="sm" textAlign="center">{errorMsg}</Text>
						</Flex>
					)}
				</Box>

				<Button
					onClick={() => { shutdown(); onClose() }}
					size="sm"
					variant="outline"
					borderColor="gray.600"
					color="gray.300"
					_hover={{ borderColor: "kk.gold", color: "kk.gold" }}
					w="100%"
				>
					Cancel
				</Button>
			</Box>
		</Flex>
	)
}
