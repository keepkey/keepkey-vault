import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Box } from "@chakra-ui/react"
import { Z } from "../lib/z-index"

/**
 * Right-click (or Shift+F10 / Menu key) menu for a sidebar chain row.
 *
 * Built like ViewPickerMenu, the vault's other hand-rolled menu: one dark
 * surface, a hairline, rows without boxes of their own, gold only for the
 * focused row. WAI-ARIA menu keys: arrows / Home / End move, Enter or Space
 * picks, Esc and Tab close. Focus returns to the row that opened it.
 */
export interface ChainMenuItem {
	key: string
	label: string
	onSelect: () => void
	disabled?: boolean
	/** Shown after the label, e.g. why an item is disabled. */
	hint?: string
}

const MENU_WIDTH = 224
const EDGE = 8

export function ChainContextMenu({ x, y, label, items, onClose, returnFocusTo }: {
	/** Viewport point to open at (pointer, or the row's corner from the keyboard). */
	x: number
	y: number
	/** Accessible name, usually the chain name. */
	label: string
	items: ChainMenuItem[]
	onClose: () => void
	returnFocusTo?: HTMLElement | null
}) {
	const menuRef = useRef<HTMLDivElement>(null)
	const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter(i => i >= 0)
	const [active, setActive] = useState(enabled[0] ?? -1)
	const [pos, setPos] = useState({ left: x, top: y })

	const close = (restore = true) => {
		onClose()
		if (restore) returnFocusTo?.focus()
	}

	// Keep the menu inside the window.
	useLayoutEffect(() => {
		const h = menuRef.current?.offsetHeight ?? 0
		const w = window.innerWidth || 1024, vh = window.innerHeight || 768
		setPos({
			left: Math.max(EDGE, Math.min(x, w - MENU_WIDTH - EDGE)),
			top: Math.max(EDGE, Math.min(y, vh - h - EDGE)),
		})
	}, [x, y])

	useEffect(() => {
		if (active >= 0) menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]")[active]?.focus()
	}, [active])

	// Outside press, window blur or scroll closes, without stealing focus back.
	useEffect(() => {
		const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) close(false) }
		const onAway = () => close(false)
		window.addEventListener("mousedown", onDown, true)
		window.addEventListener("blur", onAway)
		window.addEventListener("resize", onAway)
		return () => {
			window.removeEventListener("mousedown", onDown, true)
			window.removeEventListener("blur", onAway)
			window.removeEventListener("resize", onAway)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const pick = (it: ChainMenuItem) => {
		if (it.disabled) return
		close()
		it.onSelect()
	}

	const move = (dir: 1 | -1) => {
		if (!enabled.length) return
		const at = enabled.indexOf(active)
		setActive(enabled[(at + dir + enabled.length) % enabled.length])
	}

	const onKeyDown = (e: React.KeyboardEvent) => {
		switch (e.key) {
			case "ArrowDown": e.preventDefault(); move(1); break
			case "ArrowUp": e.preventDefault(); move(-1); break
			case "Home": e.preventDefault(); setActive(enabled[0] ?? -1); break
			case "End": e.preventDefault(); setActive(enabled[enabled.length - 1] ?? -1); break
			case "Escape": e.preventDefault(); e.stopPropagation(); close(); break
			case "Tab": e.preventDefault(); close(); break
			// Handled here (not left to the button's native activation) so a
			// pick fires exactly once whatever the host does with key events.
			case "Enter": case " ": e.preventDefault(); if (items[active]) pick(items[active]); break
		}
	}

	return (
		<Box
			ref={menuRef}
			role="menu"
			aria-label={label}
			data-chain-menu
			position="fixed"
			style={{ left: pos.left, top: pos.top, width: MENU_WIDTH }}
			bg="var(--ink-1)"
			border="1px solid var(--line)"
			borderRadius="lg"
			boxShadow="0 24px 64px rgba(0,0,0,0.55)"
			p="1"
			zIndex={Z.nav + 2}
			onKeyDown={onKeyDown}
			onContextMenu={(e: React.MouseEvent) => e.preventDefault()}
		>
			{items.map((it, i) => (
				<Box
					key={it.key}
					as="button"
					role="menuitem"
					data-item={it.key}
					tabIndex={i === active ? 0 : -1}
					aria-disabled={it.disabled || undefined}
					onClick={() => pick(it)}
					onMouseEnter={() => { if (!it.disabled) setActive(i) }}
					w="100%"
					textAlign="left"
					px="2.5"
					py="2"
					borderRadius="md"
					fontSize="13px"
					lineHeight="1.3"
					bg={i === active ? "var(--ink-3)" : "transparent"}
					color={it.disabled ? "var(--text-3)" : i === active ? "var(--gold)" : "var(--text-0)"}
					cursor={it.disabled ? "not-allowed" : "pointer"}
					outline="none"
					transition="background 0.12s, color 0.12s"
					display="flex"
					justifyContent="space-between"
					gap="3"
				>
					<span>{it.label}</span>
					{it.hint && <Box as="span" fontSize="11px" color="var(--text-3)">{it.hint}</Box>}
				</Box>
			))}
		</Box>
	)
}

/** True for the keys that open a context menu from the keyboard. */
export function isContextMenuKey(e: { key: string; shiftKey: boolean }): boolean {
	return e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")
}
