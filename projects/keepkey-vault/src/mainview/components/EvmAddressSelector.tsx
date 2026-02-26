import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { FaPlus, FaTimes } from "react-icons/fa"
import { formatUsd } from "../lib/formatting"
import type { EvmAddressSet } from "../../shared/types"

interface EvmAddressSelectorProps {
  evmAddresses: EvmAddressSet
  onSelectIndex: (index: number) => void
  onAddIndex: () => void
  onRemoveIndex?: (index: number) => void
  adding: boolean
}

export function EvmAddressSelector({ evmAddresses, onSelectIndex, onAddIndex, onRemoveIndex, adding }: EvmAddressSelectorProps) {
  const { addresses, selectedIndex } = evmAddresses

  // Don't render if only one address tracked
  if (addresses.length <= 1) return null

  return (
    <Box mb="3">
      <Flex gap="1" mb="1" align="center">
        <Text fontSize="10px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.05em">
          EVM Address
        </Text>
      </Flex>
      <Flex gap="1.5" flexWrap="wrap" align="center">
        {addresses.map(addr => {
          const isSelected = addr.addressIndex === selectedIndex
          const snippet = addr.address
            ? `${addr.address.slice(0, 6)}...${addr.address.slice(-4)}`
            : `Index ${addr.addressIndex}`

          return (
            <Box
              key={addr.addressIndex}
              position="relative"
              as="button"
              onClick={() => onSelectIndex(addr.addressIndex)}
              bg={isSelected ? "rgba(255,215,0,0.12)" : "rgba(255,255,255,0.03)"}
              border="1px solid"
              borderColor={isSelected ? "kk.gold" : "kk.border"}
              borderRadius="lg"
              px="3"
              py="1.5"
              cursor="pointer"
              transition="all 0.15s"
              _hover={{ borderColor: "kk.gold", bg: "rgba(255,215,0,0.06)" }}
            >
              <Flex direction="column" align="center" gap="0.5">
                <Text fontSize="11px" fontWeight="600" color={isSelected ? "kk.gold" : "kk.textPrimary"} lineHeight="1.2">
                  #{addr.addressIndex}
                </Text>
                <Text fontSize="10px" fontFamily="mono" color="kk.textMuted" lineHeight="1.2">
                  {snippet}
                </Text>
                {addr.balanceUsd > 0 && (
                  <Text fontSize="9px" color="kk.textMuted" lineHeight="1.2">
                    ${formatUsd(addr.balanceUsd)}
                  </Text>
                )}
              </Flex>
              {/* Remove button for non-zero indices */}
              {addr.addressIndex !== 0 && onRemoveIndex && (
                <Box
                  as="button"
                  position="absolute"
                  top="-4px"
                  right="-4px"
                  w="14px"
                  h="14px"
                  borderRadius="full"
                  bg="rgba(255,255,255,0.1)"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  _hover={{ bg: "rgba(255,59,48,0.3)" }}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveIndex(addr.addressIndex)
                  }}
                >
                  <Box as={FaTimes} fontSize="7px" color="kk.textMuted" />
                </Box>
              )}
            </Box>
          )
        })}
        <Button
          size="xs"
          variant="ghost"
          color="kk.textMuted"
          _hover={{ color: "kk.gold" }}
          onClick={onAddIndex}
          disabled={adding}
          px="2"
          minW="auto"
        >
          <Box as={FaPlus} fontSize="10px" />
        </Button>
      </Flex>
    </Box>
  )
}
