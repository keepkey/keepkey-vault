import type { CSSProperties } from 'react';
import { Icon } from './Icon';
import type { IconName } from './types';

export interface PillTabItem<T extends string = string> {
	id: T;
	label: string;
	icon?: IconName;
}

interface PillTabsProps<T extends string = string> {
	items: ReadonlyArray<PillTabItem<T>>;
	active: T;
	onChange: (id: T) => void;
	/** 'nav' = ink-4 active pill (top nav). 'action' = gold active pill (asset-page tabs). */
	variant?: 'nav' | 'action';
	style?: CSSProperties;
}

export function PillTabs<T extends string = string>({
	items,
	active,
	onChange,
	variant = 'nav',
	style,
}: PillTabsProps<T>) {
	const activeBg     = variant === 'action' ? 'var(--gold)'  : 'var(--ink-4)';
	const activeColor  = variant === 'action' ? 'var(--ink-0)' : 'var(--text-0)';
	const padX         = variant === 'action' ? 22 : 18;
	const padY         = variant === 'action' ? 10 : 8;
	const fontSize     = variant === 'action' ? 14 : 13;

	return (
		<nav
			style={{
				display: 'inline-flex',
				gap: variant === 'action' ? 2 : 4,
				background: 'var(--ink-2)',
				padding: 4,
				borderRadius: 999,
				border: '1px solid var(--line)',
				...style,
			}}
		>
			{items.map((it) => {
				const isActive = active === it.id;
				return (
					<button
						key={it.id}
						type="button"
						onClick={() => onChange(it.id)}
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 8,
							padding: `${padY}px ${padX}px`,
							borderRadius: 999,
							fontSize,
							fontWeight: 500,
							color: isActive ? activeColor : 'var(--text-2)',
							background: isActive ? activeBg : 'transparent',
							transition: 'all 0.2s',
							cursor: 'pointer',
							border: 0,
							fontFamily: 'inherit',
						}}
					>
						{it.icon && <Icon name={it.icon} size={14}/>}
						{it.label}
					</button>
				);
			})}
		</nav>
	);
}
