import type { CSSProperties, SVGProps } from 'react';
import type { IconName } from './types';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
	name: IconName;
	size?: number;
	style?: CSSProperties;
}

export function Icon({ name, size = 18, ...rest }: IconProps) {
	const common: SVGProps<SVGSVGElement> = {
		width: size,
		height: size,
		viewBox: '0 0 24 24',
		fill: 'none',
		stroke: 'currentColor',
		strokeWidth: 1.5,
		strokeLinecap: 'round',
		strokeLinejoin: 'round',
		...rest,
	};
	switch (name) {
		case 'arrowDown':   return <svg {...common}><path d="M12 5v14M6 13l6 6 6-6"/></svg>;
		case 'arrowUp':     return <svg {...common}><path d="M12 19V5M6 11l6-6 6 6"/></svg>;
		case 'swap':        return <svg {...common}><path d="M7 4l-4 4 4 4M3 8h13M17 20l4-4-4-4M21 16H8"/></svg>;
		case 'back':        return <svg {...common}><path d="M19 12H5M12 19l-7-7 7-7"/></svg>;
		case 'close':       return <svg {...common}><path d="M18 6L6 18M6 6l12 12"/></svg>;
		case 'plus':        return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
		case 'copy':        return <svg {...common}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>;
		case 'eye':         return <svg {...common}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>;
		case 'eyeOff':      return <svg {...common}><path d="M17.94 17.94A10.94 10.94 0 0112 19c-6.5 0-10-7-10-7a19 19 0 015.06-5.94M9.9 4.24A10 10 0 0112 4c6.5 0 10 7 10 7a19 19 0 01-2.16 3.19M1 1l22 22"/></svg>;
		case 'refresh':     return <svg {...common}><path d="M3 2v6h6M21 22v-6h-6"/><path d="M3 13a9 9 0 0014.85 3.36L21 13M3 11a9 9 0 0114.85-3.36L21 11"/></svg>;
		case 'edit':        return <svg {...common}><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
		case 'shield':      return <svg {...common}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
		case 'gear':        return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>;
		case 'apps':        return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>;
		case 'external':    return <svg {...common}><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6M10 14L21 3"/></svg>;
		case 'check':       return <svg {...common}><path d="M20 6L9 17l-5-5"/></svg>;
		case 'clock':       return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>;
		case 'bolt':        return <svg {...common}><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>;
		case 'arrowRight':  return <svg {...common}><path d="M5 12h14M13 5l7 7-7 7"/></svg>;
		case 'chevronDown': return <svg {...common}><path d="M6 9l6 6 6-6"/></svg>;
		case 'sparkle':     return <svg {...common}><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5z"/></svg>;
		case 'device':      return <svg {...common}><rect x="6" y="2" width="12" height="20" rx="3"/><circle cx="12" cy="18" r="1"/></svg>;
		default: return null;
	}
}
