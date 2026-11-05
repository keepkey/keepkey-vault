import { Box, Flex } from "@chakra-ui/react";
import type { ReactNode } from "react";

export function WalletTile({
  children,
  active,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <Flex
      direction="column"
      w="220px"
      minH="230px"
      bg="rgba(16,16,21,0.85)"
      border="1px solid"
      borderColor={active ? "rgba(139,227,196,0.45)" : "var(--ink-3)"}
      borderRadius="16px"
      px="3.5"
      py="3"
      backdropFilter="blur(8px)"
      boxShadow={
        active
          ? "0 0 0 1px rgba(139,227,196,0.22), 0 8px 24px -8px rgba(139,227,196,0.18)"
          : "0 1px 0 rgba(255,255,255,0.02)"
      }
      transition="all 0.2s"
      _hover={{
        borderColor: active
          ? "rgba(139,227,196,0.6)"
          : "rgba(233,196,106,0.45)",
        transform: "translateY(-1px)",
        boxShadow: active
          ? "0 0 0 1px rgba(139,227,196,0.32), 0 12px 28px -10px rgba(139,227,196,0.22)"
          : "0 8px 24px -10px rgba(233,196,106,0.18)",
      }}
    >
      {children}
    </Flex>
  );
}

export function WalletTileCta({
  children,
  onClick,
  loading,
  tone = "gold",
}: {
  children: ReactNode;
  onClick: () => void;
  loading?: boolean;
  tone?: "gold" | "teal" | "rose";
}) {
  const accent =
    tone === "teal"
      ? "var(--teal)"
      : tone === "rose"
      ? "var(--rose)"
      : "var(--gold)";
  const accentSoft =
    tone === "teal"
      ? "rgba(139,227,196,0.10)"
      : tone === "rose"
      ? "rgba(224,140,123,0.10)"
      : "rgba(233,196,106,0.10)";
  const accentBorder =
    tone === "teal"
      ? "rgba(139,227,196,0.30)"
      : tone === "rose"
      ? "rgba(224,140,123,0.30)"
      : "rgba(233,196,106,0.30)";
  const accentHover =
    tone === "teal"
      ? "rgba(139,227,196,0.20)"
      : tone === "rose"
      ? "rgba(224,140,123,0.20)"
      : "rgba(233,196,106,0.20)";
  return (
    <Box
      as="button"
      w="100%"
      px="3"
      py="1.5"
      borderRadius="10px"
      fontSize="11px"
      fontWeight="600"
      letterSpacing="0.04em"
      color={accent}
      bg={accentSoft}
      border="1px solid"
      borderColor={accentBorder}
      cursor={loading ? "wait" : "pointer"}
      opacity={loading ? 0.5 : 1}
      _hover={{ bg: accentHover }}
      mt="auto"
      onClick={onClick}
    >
      {children}
    </Box>
  );
}
