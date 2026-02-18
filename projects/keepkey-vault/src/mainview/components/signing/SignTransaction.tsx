import { useState } from "react";
import { Box, Text, VStack, Flex, Button, Textarea } from "@chakra-ui/react";
import { useApi } from "../../hooks/useApi";

interface SignTransactionProps {
	paired: boolean;
}

type TxType = "eth" | "utxo" | "cosmos" | "thorchain";

const TX_TYPES: { value: TxType; label: string; description: string }[] = [
	{ value: "eth", label: "Ethereum", description: "EVM transaction signing" },
	{ value: "utxo", label: "UTXO", description: "Bitcoin-like transaction signing" },
	{ value: "cosmos", label: "Cosmos", description: "Cosmos SDK amino signing" },
	{ value: "thorchain", label: "THORChain", description: "THORChain transfer signing" },
];

export function SignTransaction({ paired }: SignTransactionProps) {
	const { call, api, loading, error } = useApi();
	const [txType, setTxType] = useState<TxType>("eth");
	const [txInput, setTxInput] = useState("");
	const [result, setResult] = useState<string | null>(null);

	if (!paired) {
		return (
			<VStack gap="4" align="stretch">
				<Text fontSize="2xl" fontWeight="bold" color="kk.gold">Sign Transaction</Text>
				<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
					<Text color="kk.textSecondary">
						Pair with keepkey-desktop from the Dashboard to sign transactions.
					</Text>
				</Box>
			</VStack>
		);
	}

	const handleSign = async () => {
		if (!txInput.trim()) return;
		setResult(null);

		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(txInput);
		} catch {
			setResult("Error: Invalid JSON input");
			return;
		}

		let signResult: Record<string, unknown> | null = null;

		switch (txType) {
			case "eth":
				signResult = await call(() => api.signEthTransaction(parsed));
				break;
			case "utxo":
				signResult = await call(() => api.signUtxoTransaction(parsed));
				break;
			case "cosmos":
				signResult = await call(() =>
					api.signCosmosAmino(
						parsed.signerAddress as string,
						parsed.signDoc,
					),
				);
				break;
			case "thorchain":
				signResult = await call(() =>
					api.signThorchainTransfer(
						parsed.signerAddress as string,
						parsed.signDoc,
					),
				);
				break;
		}

		if (signResult) {
			setResult(JSON.stringify(signResult, null, 2));
		}
	};

	return (
		<VStack gap="6" align="stretch">
			<Text fontSize="2xl" fontWeight="bold" color="kk.gold">Sign Transaction</Text>

			{/* TX Type Selector */}
			<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
				<Text fontSize="lg" fontWeight="semibold" mb="4">Transaction Type</Text>
				<Flex gap="3" flexWrap="wrap">
					{TX_TYPES.map((t) => (
						<Box
							key={t.value}
							as="button"
							onClick={() => setTxType(t.value)}
							bg={txType === t.value ? "rgba(255, 215, 0, 0.1)" : "kk.bg"}
							border="1px solid"
							borderColor={txType === t.value ? "kk.gold" : "kk.border"}
							borderRadius="lg"
							p="3"
							cursor="pointer"
							textAlign="left"
							_hover={{ borderColor: "kk.gold" }}
							transition="all 0.15s ease"
						>
							<Text
								fontWeight="semibold"
								fontSize="sm"
								color={txType === t.value ? "kk.gold" : "kk.textPrimary"}
							>
								{t.label}
							</Text>
							<Text color="kk.textMuted" fontSize="xs">{t.description}</Text>
						</Box>
					))}
				</Flex>
			</Box>

			{/* TX Input */}
			<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
				<Text fontSize="lg" fontWeight="semibold" mb="4">Transaction Payload (JSON)</Text>
				<Textarea
					value={txInput}
					onChange={(e) => setTxInput(e.target.value)}
					placeholder={`Paste ${txType.toUpperCase()} transaction JSON here...`}
					bg="kk.bg"
					border="1px solid"
					borderColor="kk.border"
					fontFamily="mono"
					fontSize="sm"
					minH="200px"
					_focus={{ borderColor: "kk.gold" }}
				/>
				<Flex mt="4" gap="3">
					<Button
						onClick={handleSign}
						disabled={loading || !txInput.trim()}
						bg="kk.gold"
						color="black"
						fontWeight="semibold"
						_hover={{ bg: "kk.goldHover" }}
						size="sm"
					>
						{loading ? "Signing..." : "Sign Transaction"}
					</Button>
					<Button
						onClick={() => { setTxInput(""); setResult(null); }}
						variant="outline"
						borderColor="kk.border"
						color="kk.textSecondary"
						_hover={{ borderColor: "kk.gold" }}
						size="sm"
					>
						Clear
					</Button>
				</Flex>
			</Box>

			{/* Error */}
			{error && (
				<Box bg="rgba(255, 23, 68, 0.1)" borderRadius="lg" p="3" border="1px solid" borderColor="kk.error">
					<Text color="kk.error" fontSize="sm">{error}</Text>
				</Box>
			)}

			{/* Result */}
			{result && (
				<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
					<Text fontSize="lg" fontWeight="semibold" mb="4">Signed Result</Text>
					<Box
						bg="kk.bg"
						borderRadius="md"
						border="1px solid"
						borderColor="kk.border"
						p="4"
						fontFamily="mono"
						fontSize="xs"
						whiteSpace="pre-wrap"
						wordBreak="break-all"
						maxH="300px"
						overflow="auto"
					>
						{result}
					</Box>
					<Button
						onClick={() => navigator.clipboard.writeText(result)}
						mt="3"
						size="xs"
						variant="outline"
						borderColor="kk.border"
						color="kk.textSecondary"
						_hover={{ borderColor: "kk.gold", color: "kk.gold" }}
					>
						Copy Result
					</Button>
				</Box>
			)}
		</VStack>
	);
}
