import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ChakraProvider } from "@chakra-ui/react"
import { system } from "./theme"
import "./index.css"
import App from "./App"

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ChakraProvider value={system}>
			<App />
		</ChakraProvider>
	</StrictMode>,
)
