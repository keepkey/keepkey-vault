import { useState } from "react";
import { Box, Text, VStack, Flex, Button, HStack } from "@chakra-ui/react";
import { SUPPORTED_CHAINS, type DerivedAddress } from "../../types";
import { useApi } from "../../hooks/useApi";

interface AddressPanelProps {
	paired: boolean;
}

// Default BIP44 paths per chain
const DEFAULT_PATHS: Record<string, number[]> = {
	bitcoin: [0x80000000 + 44, 0x80000000 + 0, 0x80000000 + 0, 0, 0],
	ethereum: [0x80000000 + 44, 0x80000000 + 60, 0x80000000 + 0, 0, 0],
	cosmos: [0x80000000 + 44, 0x80000000 + 118, 0x80000000 + 0, 0, 0],
	thorchain: [0x80000000 + 44, 0x80000000 + 931, 0x80000000 + 0, 0, 0],
	osmosis: [0x80000000 + 44, 0x80000000 + 118, 0x80000000 + 0, 0, 0],
	litecoin: [0x80000000 + 44, 0x80000000 + 2, 0x80000000 + 0, 0, 0],
	dogecoin: [0x80000000 + 44, 0x80000000 + 3, 0x80000000 + 0, 0, 0],
	bitcoincash: [0x80000000 + 44, 0x80000000 + 145, 0x80000000 + 0, 0, 0],
	dash: [0x80000000 + 44, 0x80000000 + 5, 0x80000000 + 0, 0, 0],
	ripple: [0x80000000 + 44, 0x80000000 + 144, 0x80000000 + 0, 0, 0],
	mayachain: [0x80000000 + 44, 0x80000000 + 931, 0x80000000 + 0, 0, 0],
	binance: [0x80000000 + 44, 0x80000000 + 714, 0x80000000 + 0, 0, 0],
};

const UTXO_COINS: Record<string, string> = {
	bitcoin: "Bitcoin",
	litecoin: "Litecoin",
	dogecoin: "Dogecoin",
	bitcoincash: "BitcoinCash",
	dash: "Dash",
};

export function AddressPanel({ paired }: AddressPanelProps) {
	const { call, api, loading } = useApi();
	const [addresses, setAddresses] = useState<DerivedAddress[]>([]);
	const [deriving, setDeriving] = useState<string | null>(null);
	const [copied, setCopied] = useState<string | null>(null);

	if (!paired) {
		return (
			<VStack gap="4" align="stretch">
				<Text fontSize="2xl" fontWeight="bold" color="kk.gold">Addresses</Text>
				<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
					<Text color="kk.textSecondary">
						Pair with keepkey-desktop from the Dashboard to derive addresses.
					</Text>
				</Box>
			</VStack>
		);
	}

	const deriveAddress = async (chainId: string) => {
		setDeriving(chainId);
		const path = DEFAULT_PATHS[chainId];
		if (!path) return;

		let result: { address: string } | null = null;

		if (UTXO_COINS[chainId]) {
			result = await call(() => api.getUtxoAddress(path, UTXO_COINS[chainId]));
		} else if (chainId === "ethereum") {
			result = await call(() => api.getEthAddress(path));
		} else if (chainId === "cosmos" || chainId === "osmosis") {
			result = await call(() => api.getCosmosAddress(path));
		} else if (chainId === "thorchain") {
			result = await call(() => api.getThorchainAddress(path));
		} else if (chainId === "mayachain") {
			result = await call(() => api.getMayachainAddress(path));
		} else if (chainId === "ripple") {
			result = await call(() => api.getXrpAddress(path));
		} else if (chainId === "binance") {
			result = await call(() => api.getBnbAddress(path));
		}

		if (result) {
			setAddresses((prev) => {
				const filtered = prev.filter((a) => a.chain !== chainId);
				return [...filtered, {
					chain: chainId as DerivedAddress["chain"],
					address: result.address,
					path: path.map((n) => (n >= 0x80000000 ? `${n - 0x80000000}'` : `${n}`)).join("/"),
				}];
			});
		}
		setDeriving(null);
	};

	const deriveAll = async () => {
		for (const chain of SUPPORTED_CHAINS) {
			await deriveAddress(chain.chain);
		}
	};

	const copyAddress = (address: string) => {
		navigator.clipboard.writeText(address);
		setCopied(address);
		setTimeout(() => setCopied(null), 2000);
	};

	return (
		<VStack gap="6" align="stretch">
			<Flex alignItems="center" justifyContent="space-between">
				<Text fontSize="2xl" fontWeight="bold" color="kk.gold">Addresses</Text>
				<Button
					onClick={deriveAll}
					disabled={loading}
					bg="kk.gold"
					color="black"
					fontWeight="semibold"
					_hover={{ bg: "kk.goldHover" }}
					size="sm"
				>
					Derive All
				</Button>
			</Flex>

			{SUPPORTED_CHAINS.map((chain) => {
				const derived = addresses.find((a) => a.chain === chain.chain);
				const isDeriving = deriving === chain.chain;

				return (
					<Box
						key={chain.chain}
						bg="kk.cardBg"
						borderRadius="xl"
						border="1px solid"
						borderColor="kk.border"
						p="4"
					>
						<Flex alignItems="center" gap="3" mb={derived ? "3" : "0"}>
							<Box
								w="32px"
								h="32px"
								borderRadius="full"
								bg={chain.color}
								display="flex"
								alignItems="center"
								justifyContent="center"
								fontSize="xs"
								fontWeight="bold"
								color="white"
								flexShrink={0}
							>
								{chain.symbol.slice(0, 2)}
							</Box>
							<Box flex="1">
								<Text fontWeight="semibold" fontSize="sm">{chain.name}</Text>
								<Text color="kk.textMuted" fontSize="xs">{chain.symbol}</Text>
							</Box>
							{!derived && (
								<Button
									onClick={() => deriveAddress(chain.chain)}
									disabled={isDeriving || loading}
									size="xs"
									variant="outline"
									borderColor="kk.border"
									color="kk.textSecondary"
									_hover={{ borderColor: "kk.gold", color: "kk.gold" }}
								>
									{isDeriving ? "..." : "Derive"}
								</Button>
							)}
						</Flex>

						{derived && (
							<HStack
								bg="kk.bg"
								borderRadius="md"
								p="2"
								gap="2"
							>
								<Text
									fontSize="xs"
									fontFamily="mono"
									color="kk.textSecondary"
									flex="1"
									wordBreak="break-all"
								>
									{derived.address}
								</Text>
								<Button
									onClick={() => copyAddress(derived.address)}
									size="xs"
									variant="ghost"
									color={copied === derived.address ? "kk.success" : "kk.textMuted"}
									_hover={{ color: "kk.gold" }}
									flexShrink={0}
								>
									{copied === derived.address ? "Copied" : "Copy"}
								</Button>
							</HStack>
						)}
					</Box>
				);
			})}
		</VStack>
	);
}
