import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ChakraProvider } from "@chakra-ui/react"
import { system } from "./theme"
import "./index.css"
import "./i18n"
import splashBg from "./assets/splash-bg.png"
import App from "./App"
import { FiatProvider } from "./lib/fiat-context"

// Global error handler — prevent stray promise rejections from crashing the WebView
window.addEventListener('unhandledrejection', (e) => {
	console.error('[WebView] Unhandled rejection:', e.reason)
	e.preventDefault()
})

// Set background on <body> so it's visible behind every overlay and phase
document.body.style.background = `#000000 url(${splashBg}) center / cover no-repeat fixed`

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ChakraProvider value={system}>
			<FiatProvider>
				<App />
			</FiatProvider>
		</ChakraProvider>
	</StrictMode>,
)
