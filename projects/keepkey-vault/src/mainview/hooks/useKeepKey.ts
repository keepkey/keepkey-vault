import { useState, useEffect, useCallback } from "react";
import { keepkeyApi } from "../services/keepkey-api";
import type { ConnectionStatus, DeviceInfo } from "../types";

const API_KEY_STORAGE = "keepkey-vault-api-key";
const POLL_INTERVAL = 5000;

export function useKeepKey() {
	const [status, setStatus] = useState<ConnectionStatus>({
		desktop: false,
		device: false,
		paired: false,
	});
	const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
	const [pairing, setPairing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/** Attempt to restore a saved API key and verify it */
	const restoreSession = useCallback(async () => {
		const stored = localStorage.getItem(API_KEY_STORAGE);
		if (!stored) return false;

		keepkeyApi.setApiKey(stored);
		const valid = await keepkeyApi.verifyPair();
		if (valid) {
			setStatus((s) => ({ ...s, paired: true }));
			return true;
		}
		localStorage.removeItem(API_KEY_STORAGE);
		keepkeyApi.setApiKey("");
		return false;
	}, []);

	/** Pair with keepkey-desktop */
	const pair = useCallback(async () => {
		setPairing(true);
		setError(null);
		try {
			const result = await keepkeyApi.pair(
				"KeepKey Vault",
				"electrobun://keepkey-vault",
				"https://keepkey.com/favicon.ico",
			);
			keepkeyApi.setApiKey(result.apiKey);
			localStorage.setItem(API_KEY_STORAGE, result.apiKey);
			setStatus((s) => ({ ...s, paired: true }));
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : "Pairing failed");
			return false;
		} finally {
			setPairing(false);
		}
	}, []);

	/** Fetch device features */
	const refreshDeviceInfo = useCallback(async () => {
		if (!status.paired) return;
		try {
			const features = await keepkeyApi.getFeatures();
			setDeviceInfo({
				vendor: (features.vendor as string) || "KeepKey",
				model: (features.model as string) || "KeepKey",
				deviceId: (features.device_id as string) || "",
				label: (features.label as string) || "My KeepKey",
				firmwareVersion: `${features.major_version || 0}.${features.minor_version || 0}.${features.patch_version || 0}`,
				initialized: (features.initialized as boolean) ?? false,
				pinProtection: (features.pin_protection as boolean) ?? false,
				passphraseProtection: (features.passphrase_protection as boolean) ?? false,
			});
			setStatus((s) => ({ ...s, device: true }));
		} catch {
			setDeviceInfo(null);
			setStatus((s) => ({ ...s, device: false }));
		}
	}, [status.paired]);

	/** Poll keepkey-desktop connectivity */
	useEffect(() => {
		let mounted = true;

		const check = async () => {
			if (!mounted) return;
			const alive = await keepkeyApi.ping();
			setStatus((s) => ({ ...s, desktop: alive }));
			if (alive && !status.paired) {
				await restoreSession();
			}
		};

		check();
		const interval = setInterval(check, POLL_INTERVAL);
		return () => {
			mounted = false;
			clearInterval(interval);
		};
	}, [status.paired, restoreSession]);

	/** Refresh device info when paired */
	useEffect(() => {
		if (status.paired) {
			refreshDeviceInfo();
		}
	}, [status.paired, refreshDeviceInfo]);

	return {
		status,
		deviceInfo,
		pairing,
		error,
		pair,
		refreshDeviceInfo,
	};
}
