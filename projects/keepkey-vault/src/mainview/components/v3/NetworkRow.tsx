import { type MouseEvent } from 'react';
import { Icon } from './Icon';
import { TokenLogo } from './TokenLogo';
import type { NetworkLike } from './types';

interface NetworkRowProps {
	network: NetworkLike;
	/** Total USD across visible portfolio — used for the percentage column. */
	totalUsd: number;
	hidden?: boolean;
	onSelect?: (network: NetworkLike) => void;
	onToggle?: () => void;
	/** Pre-formatted "value" cell. Defaults to a USD formatter. */
	formatUsd?: (n: number) => string;
	/** Pre-formatted balance cell (uses native amount). */
	formatAmount?: (n: number, decimals?: number) => string;
}

const defaultUsd = (n: number) =>
	'$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const defaultAmt = (n: number, d = 6) =>
	Number(n).toLocaleString('en-US', { maximumFractionDigits: d });

export function NetworkRow({
	network,
	totalUsd,
	hidden = false,
	onSelect,
	onToggle,
	formatUsd = defaultUsd,
	formatAmount = defaultAmt,
}: NetworkRowProps) {
	const nativeAmount = network.native?.amount ?? 0;
	const pct = totalUsd > 0 ? (network.usd / totalUsd) * 100 : 0;

	const handleSelect = () => {
		if (!hidden && onSelect) onSelect(network);
	};

	const handleToggle = (e: MouseEvent) => {
		e.stopPropagation();
		onToggle?.();
	};

	return (
		<div
			onClick={handleSelect}
			onMouseEnter={(e) => {
				if (hidden) return;
				e.currentTarget.style.background = 'var(--ink-2)';
				e.currentTarget.style.borderColor = 'var(--line-2)';
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.background = 'var(--ink-1)';
				e.currentTarget.style.borderColor = 'var(--line)';
			}}
			style={{
				display: 'grid',
				gridTemplateColumns: '44px 1fr 140px 140px 140px 40px',
				alignItems: 'center',
				gap: 16,
				padding: '14px 16px',
				borderRadius: 'var(--r-md)',
				background: 'var(--ink-1)',
				border: '1px solid var(--line)',
				cursor: hidden ? 'default' : 'pointer',
				opacity: hidden ? 0.4 : 1,
				transition: 'all 0.2s',
			}}
		>
			<TokenLogo
				token={{
					sym: network.sym,
					color: network.color,
					glyph: network.glyph,
					logo: network.logo,
				}}
				size={36}
			/>
			<div>
				<div style={{ fontSize: 14, fontWeight: 500 }}>{network.name}</div>
				{network.chain && (
					<div className="v3-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
						{network.chain}
					</div>
				)}
			</div>
			<div className="v3-mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>
				{network.tokens.length} {network.tokens.length === 1 ? 'asset' : 'assets'}
			</div>
			<div className="v3-mono" style={{ fontSize: 13, color: 'var(--text-1)', textAlign: 'right' }}>
				{formatAmount(nativeAmount, 4)}{' '}
				<span style={{ color: 'var(--text-3)' }}>{network.sym}</span>
			</div>
			<div style={{ textAlign: 'right' }}>
				<div className="v3-mono" style={{ fontSize: 14, color: 'var(--text-0)', fontWeight: 500 }}>
					{formatUsd(network.usd)}
				</div>
				<div className="v3-mono" style={{ fontSize: 10, color: 'var(--text-3)' }}>
					{pct.toFixed(1)}%
				</div>
			</div>
			{onToggle ? (
				<button
					type="button"
					onClick={handleToggle}
					aria-label={hidden ? 'Show network' : 'Hide network'}
					style={{
						width: 32,
						height: 32,
						borderRadius: 8,
						color: 'var(--text-3)',
						display: 'grid',
						placeItems: 'center',
						background: 'transparent',
						border: 0,
						cursor: 'pointer',
					}}
				>
					<Icon name={hidden ? 'eyeOff' : 'eye'} size={14}/>
				</button>
			) : (
				<span/>
			)}
		</div>
	);
}
