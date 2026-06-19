import { useEffect, useRef, useState } from "react"
import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { FaPlus, FaTimes, FaCheck, FaChevronDown } from "react-icons/fa"
import { useFiat } from "../lib/fiat-context"
import type { EvmAddressSet } from "../../shared/types"

interface EvmAddressSelectorProps {
  evmAddresses: EvmAddressSet
  onSelectIndex: (index: number) => void
  onAddIndex: () => void
  onRemoveIndex?: (index: number) => void
  adding: boolean
  /**
   * Compact dropdown variant from the AssetPage design study. Renders as a
   * single trigger button (`# N · Account #N · 0x…`) that opens a popover
   * menu listing every account plus an "Add account" row. Lets the selector
   * sit inline with the Receive/Send/Swap action pills without the multi-
   * row chip layout the default variant uses.
   */
  compact?: boolean
}

function snippet(addr: { address?: string; addressIndex: number }): string {
  if (!addr.address) return `Index ${addr.addressIndex}`
  return `${addr.address.slice(0, 6)}…${addr.address.slice(-4)}`
}

export function EvmAddressSelector({ evmAddresses, onSelectIndex, onAddIndex, onRemoveIndex, adding, compact }: EvmAddressSelectorProps) {
  const { fmtCompact } = useFiat()
  const { addresses, selectedIndex } = evmAddresses

  // Always hide when there's nothing to pick between AND no add-affordance is
  // useful. The compact variant still renders so the inline slot reserves
  // vertical space, but only when there's at least one tracked address.
  if (!compact && addresses.length <= 1) return null
  if (compact && addresses.length === 0) return null

  if (compact) {
    return <CompactSelector
      addresses={addresses}
      selectedIndex={selectedIndex}
      onSelectIndex={onSelectIndex}
      onAddIndex={onAddIndex}
      adding={adding}
    />
  }

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
          return (
            <Box
              key={addr.addressIndex}
              position="relative"
              as="button"
              onClick={() => onSelectIndex(addr.addressIndex)}
              bg={isSelected ? "rgba(233,196,106,0.12)" : "rgba(255,255,255,0.03)"}
              border="1px solid"
              borderColor={isSelected ? "kk.gold" : "kk.border"}
              borderRadius="lg"
              px="3"
              py="1.5"
              cursor="pointer"
              transition="all 0.15s"
              _hover={{ borderColor: "kk.gold", bg: "rgba(233,196,106,0.06)" }}
            >
              <Flex direction="column" align="center" gap="0.5">
                <Text fontSize="11px" fontWeight="600" color={isSelected ? "kk.gold" : "kk.textPrimary"} lineHeight="1.2">
                  #{addr.addressIndex}
                </Text>
                <Text fontSize="10px" fontFamily="mono" color="kk.textMuted" lineHeight="1.2">
                  {snippet(addr)}
                </Text>
                {addr.balanceUsd > 0 && (
                  <Text fontSize="9px" color="kk.textMuted" lineHeight="1.2">
                    {fmtCompact(addr.balanceUsd)}
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

// ─── Compact dropdown variant ─────────────────────────────────────────

interface CompactSelectorProps {
  addresses: EvmAddressSet["addresses"]
  selectedIndex: number
  onSelectIndex: (index: number) => void
  onAddIndex: () => void
  adding: boolean
}

function CompactSelector({ addresses, selectedIndex, onSelectIndex, onAddIndex, adding }: CompactSelectorProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  // Click-outside + Escape close. Bound only while open so other popovers
  // (settings, wallet selector) keep working when this is closed.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return
      if (ref.current.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const selected = addresses.find(a => a.addressIndex === selectedIndex) || addresses[0]
  if (!selected) return null

  return (
    <Box ref={ref} position="relative" display="inline-block">
      <Box
        as="button"
        onClick={() => setOpen(o => !o)}
        className="v3-glass-pill electrobun-webkit-app-region-no-drag"
        display="flex"
        alignItems="center"
        gap="2"
        px="3"
        py="1.5"
        minW="180px"
        cursor="pointer"
        transition="all 0.15s"
        _hover={{ bg: "rgba(255,255,255,0.06)" }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Box
          w="22px"
          h="22px"
          borderRadius="full"
          bg="rgba(255,255,255,0.06)"
          display="flex"
          alignItems="center"
          justifyContent="center"
          flexShrink={0}
        >
          <Text fontSize="9px" fontFamily="mono" color="var(--text-2)" fontWeight="600">
            #{selected.addressIndex}
          </Text>
        </Box>
        <Box flex="1" textAlign="left" minW="0">
          <Text fontSize="12px" fontWeight="600" color="var(--text-0)" lineHeight="1.1" truncate>
            Account #{selected.addressIndex}
          </Text>
          <Text fontSize="10px" fontFamily="mono" color="var(--text-3)" lineHeight="1.2" truncate>
            {snippet(selected)}
          </Text>
        </Box>
        <Box as={FaChevronDown} fontSize="9px" color="var(--text-3)" flexShrink={0} />
      </Box>

      {open && (
        <Box
          position="absolute"
          top="calc(100% + 6px)"
          left="0"
          minW="260px"
          zIndex={9999}
          className="v3-glass-card-overlay electrobun-webkit-app-region-no-drag"
          py="1.5"
        >
          {addresses.map(addr => {
            const isSelected = addr.addressIndex === selectedIndex
            return (
              <Box
                key={addr.addressIndex}
                as="button"
                w="100%"
                px="3"
                py="2"
                bg="transparent"
                _hover={{ bg: "rgba(255,255,255,0.08)" }}
                cursor="pointer"
                textAlign="left"
                onClick={() => { onSelectIndex(addr.addressIndex); setOpen(false) }}
                role="menuitemradio"
                aria-checked={isSelected}
              >
                <Flex align="center" gap="2.5">
                  <Box
                    w="22px"
                    h="22px"
                    borderRadius="full"
                    bg={isSelected ? "rgba(139,227,196,0.15)" : "rgba(255,255,255,0.06)"}
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    flexShrink={0}
                  >
                    <Text fontSize="9px" fontFamily="mono" color={isSelected ? "var(--teal)" : "var(--text-2)"} fontWeight="600">
                      #{addr.addressIndex}
                    </Text>
                  </Box>
                  <Box flex="1" minW="0">
                    <Text fontSize="12px" fontWeight="600" color="var(--text-0)" lineHeight="1.1">
                      Account #{addr.addressIndex}
                    </Text>
                    <Text fontSize="10px" fontFamily="mono" color="var(--text-2)" lineHeight="1.2" truncate>
                      {snippet(addr)}
                    </Text>
                  </Box>
                  {isSelected && (
                    <Box as={FaCheck} color="var(--teal)" fontSize="10px" flexShrink={0} />
                  )}
                </Flex>
              </Box>
            )
          })}
          <Box borderTop="1px solid rgba(255,255,255,0.06)" mt="1" pt="1">
            <Box
              as="button"
              w="100%"
              px="3"
              py="2"
              bg="transparent"
              _hover={{ bg: "rgba(255,255,255,0.08)" }}
              cursor={adding ? "wait" : "pointer"}
              opacity={adding ? 0.5 : 1}
              textAlign="left"
              onClick={() => { if (!adding) { onAddIndex(); setOpen(false) } }}
              aria-disabled={adding}
            >
              <Flex align="center" gap="2.5">
                <Box
                  w="22px"
                  h="22px"
                  borderRadius="full"
                  bg="rgba(139,227,196,0.10)"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  flexShrink={0}
                >
                  <Box as={FaPlus} fontSize="9px" color="var(--teal)" />
                </Box>
                <Text fontSize="12px" fontWeight="500" color="var(--teal)">
                  Add account
                </Text>
              </Flex>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  )
}
