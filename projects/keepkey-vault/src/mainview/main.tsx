import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ChakraProvider } from "@chakra-ui/react"
import { system } from "./theme"
import "./index.css"
import "./i18n"
import splashBg from "./assets/splash-bg.png"
import App from "./App"

// Set background on <body> so it's visible behind every overlay and phase
document.body.style.background = `#000000 url(${splashBg}) center / cover no-repeat fixed`

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ChakraProvider value={system}>
			<App />
		</ChakraProvider>
	</StrictMode>,
)
