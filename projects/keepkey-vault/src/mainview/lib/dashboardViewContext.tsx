import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

export type DashboardView = "orbital" | "donut" | "heatmap"
const STORAGE_KEY = "keepkey.dashboard.view"

interface Ctx {
	viewMode: DashboardView
	setViewMode: (v: DashboardView) => void
}

const DashboardViewContext = createContext<Ctx | null>(null)

export function DashboardViewProvider({ children }: { children: ReactNode }) {
	const [viewMode, setViewMode] = useState<DashboardView>(() => {
		try {
			const saved = localStorage.getItem(STORAGE_KEY)
			if (saved === "donut" || saved === "heatmap") return saved
			return "orbital"
		} catch { return "orbital" }
	})
	useEffect(() => {
		try { localStorage.setItem(STORAGE_KEY, viewMode) } catch { /* private mode etc. */ }
	}, [viewMode])
	return (
		<DashboardViewContext.Provider value={{ viewMode, setViewMode }}>
			{children}
		</DashboardViewContext.Provider>
	)
}

/** Returns the current dashboard view + setter. Returns a noop pair when used
 *  outside the provider so non-Dashboard screens don't crash. */
export function useDashboardView(): Ctx {
	const ctx = useContext(DashboardViewContext)
	if (ctx) return ctx
	return { viewMode: "orbital", setViewMode: () => {} }
}
