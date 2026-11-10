import { Flex } from "@chakra-ui/react";
import { ActionButton } from "./ui/ActionButton";
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
      bg="rgba(16,16,21,0.85)"
      border="1px solid"
      borderColor={active ? "rgba(139,227,196,0.45)" : "var(--ink-3)"}
      borderRadius="card"
      p="4"
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
  // Same shared button as the actions below the grid, so card CTAs and page
  // actions share one height, radius and type size. `loading` keeps its old
  // behaviour (dimmed, wait cursor, still clickable) rather than Chakra's
  // spinner state, which would block the click.
  return (
    <ActionButton
      tone={tone}
      size="sm"
      w="100%"
      mt="auto"
      cursor={loading ? "wait" : "pointer"}
      opacity={loading ? 0.5 : 1}
      onClick={onClick}
    >
      {children}
    </ActionButton>
  );
}
