import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { TokenLogo } from './TokenLogo';
import type { TokenLike } from './types';

interface SidePanelProps {
	token: TokenLike;
	/** Eyebrow label, e.g. "You pay" / "You receive". */
	label: string;
	/** Border accent override — used on the "receive" side to tint with teal. */
	accent?: string;
	/** When provided, renders the "Change" picker pill that calls back when clicked. */
	onChange?: () => void;
	children?: ReactNode;
}

/** Side-by-side swap panel primitive. The pivot button is rendered by the
 *  parent (it overlays the gap absolutely between two SidePanels). */
export function SidePanel({ token, label, accent, onChange, children }: SidePanelProps) {
	return (
		<div
			style={{
				background: 'var(--ink-1)',
				border: `1px solid ${accent ?? 'var(--line)'}`,
				borderRadius: 16,
				padding: 20,
				display: 'flex',
				flexDirection: 'column',
				gap: 16,
				minHeight: 280,
			}}
		>
			<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
				<span
					style={{
						fontSize: 10,
						letterSpacing: '0.22em',
						textTransform: 'uppercase',
						color: 'var(--text-3)',
						fontWeight: 500,
					}}
				>
					{label}
				</span>
				{onChange && (
					<button
						type="button"
						onClick={onChange}
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 4,
							fontSize: 12,
							color: 'var(--text-2)',
							padding: '4px 8px',
							borderRadius: 8,
							background: 'var(--ink-2)',
							border: '1px solid var(--line)',
							cursor: 'pointer',
							fontFamily: 'inherit',
						}}
					>
						Change <Icon name="chevronDown" size={12}/>
					</button>
				)}
			</div>
			<div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
				<TokenLogo token={token} size={52} ring/>
				<div>
					<div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.1 }}>
						{token.sym}
					</div>
					{token.network && (
						<div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>
							{token.network}
						</div>
					)}
				</div>
			</div>
			<div style={{ height: 1, background: 'var(--line)', margin: '0 -20px' }}/>
			{children}
		</div>
	);
}
