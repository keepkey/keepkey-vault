import { Component, StrictMode, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { ChakraProvider } from "@chakra-ui/react"
import { system } from "./theme"
import "./index.css"
import "./styles/tokens.css"
import "./i18n"
import splashBg from "./assets/splash-bg.png"
import App from "./App"
import { FiatProvider } from "./lib/fiat-context"
import { DashboardViewProvider } from "./lib/dashboardViewContext"

// Global error handler — prevent stray promise rejections from crashing the WebView
window.addEventListener('unhandledrejection', (e) => {
	console.error('[WebView] Unhandled rejection:', e.reason)
	e.preventDefault()
})

// Set background on <body> so it's visible behind every overlay and phase
document.body.style.background = `#000000 url(${splashBg}) center / cover no-repeat fixed`

// Last-resort boundary: without it, any render throw blanks the whole window
// with only a minified console error to go on.
class RootBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	state = { error: null as Error | null }
	static getDerivedStateFromError(error: Error) { return { error } }
	componentDidCatch(error: Error, info: { componentStack?: string | null }) {
		console.error('[WebView] Render crash:', error, info.componentStack)
	}
	render() {
		if (!this.state.error) return this.props.children
		return (
			<div style={{ color: '#eee', fontFamily: 'monospace', padding: 24, maxWidth: 640, margin: '10vh auto' }}>
				<h2 style={{ color: '#e66464' }}>Something went wrong</h2>
				<p style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{String(this.state.error?.message ?? this.state.error)}</p>
				<button
					style={{ marginTop: 16, padding: '8px 16px', background: '#E9C46A', color: '#000', border: 0, borderRadius: 8, cursor: 'pointer' }}
					onClick={() => location.reload()}
				>
					Reload
				</button>
			</div>
		)
	}
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<RootBoundary>
			<ChakraProvider value={system}>
				<FiatProvider>
					<DashboardViewProvider>
						<App />
					</DashboardViewProvider>
				</FiatProvider>
			</ChakraProvider>
		</RootBoundary>
	</StrictMode>,
)
