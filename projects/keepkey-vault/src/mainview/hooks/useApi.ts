import { useState, useCallback } from "react";
import { keepkeyApi } from "../services/keepkey-api";

interface ApiState {
	loading: boolean;
	error: string | null;
}

/**
 * Hook for making keepkey-desktop API calls with loading/error state.
 */
export function useApi() {
	const [state, setState] = useState<ApiState>({ loading: false, error: null });

	const call = useCallback(async <T>(fn: () => Promise<T>): Promise<T | null> => {
		setState({ loading: true, error: null });
		try {
			const result = await fn();
			setState({ loading: false, error: null });
			return result;
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			setState({ loading: false, error: msg });
			return null;
		}
	}, []);

	return {
		...state,
		call,
		api: keepkeyApi,
	};
}
