import { Box, Button, Flex, HStack, Text, VStack } from "@chakra-ui/react"
import { FaChevronRight, FaDice, FaFingerprint, FaLock, FaWaveSquare } from "react-icons/fa"
import { useTranslation } from "react-i18next"

/**
 * The two OPTIONAL security steps between choosing "create wallet" and the
 * device actually generating a seed:
 *
 *   randomness -> audit the generator that is about to make your keys
 *   dice       -> add entropy the host never sees
 *
 * Both are their own page rather than a checkbox on a form, because the point
 * is participation: the user is building trust in a specific claim, not
 * ticking an option. Visual grammar matches TutorialCards (accent colour,
 * glow, icon trio, accent primary button) so these read as part of the same
 * sequence rather than bolted-on dialogs.
 *
 * Order is deliberate: randomness first (is the source sound?), then dice
 * (add something the source cannot control). Auditing after mixing dice in
 * would be measuring the wrong thing.
 */

export type SecurityStep = "randomness" | "dice"

interface StepDef {
  accent: string
  icon1: React.ReactNode
  icon2: React.ReactNode
  icon3: React.ReactNode
  title: string
  /** The WHY, before any mechanism. */
  lead: string
  /** Scannable claims — what it does and does not establish. */
  bullets: { tone: "can" | "cannot"; text: string }[]
  actionLabel: string
  skipLabel: string
}

function DiceFaces({ accent }: { accent: string }) {
  // Three pips arranged as a die face — cheaper and crisper than an asset,
  // and it inherits the step accent.
  return (
    <Flex w="34px" h="34px" borderRadius="8px" border="1px solid" borderColor={`${accent}55`}
      align="center" justify="center" gap="3px" p="1">
      {[0, 1, 2].map((i) => (
        <Box key={i} w="5px" h="5px" borderRadius="full" bg={accent} opacity={0.85 - i * 0.2} />
      ))}
    </Flex>
  )
}

function SampleBars({ accent }: { accent: string }) {
  // A tiny "signal" motif: uneven bars = raw samples being measured.
  const heights = [10, 20, 14, 26, 12, 22]
  return (
    <Flex align="flex-end" gap="3px" h="28px">
      {heights.map((h, i) => (
        <Box key={i} w="4px" h={`${h}px`} borderRadius="2px" bg={accent} opacity={0.35 + (i % 3) * 0.25} />
      ))}
    </Flex>
  )
}

export function SecurityStepPage({
  step,
  onAccept,
  onSkip,
  rollCount,
}: {
  step: SecurityStep
  onAccept: () => void
  onSkip: () => void
  /** Rolls the device will ask for, derived from seed length. */
  rollCount: number
}) {
  const { t } = useTranslation("setup")

  const RANDOMNESS_ACCENT = "#23DCC8"
  const DICE_ACCENT = "#8B5CF6"

  const defs: Record<SecurityStep, StepDef> = {
    randomness: {
      accent: RANDOMNESS_ACCENT,
      icon1: <FaWaveSquare size={28} color={RANDOMNESS_ACCENT} />,
      icon2: <SampleBars accent={RANDOMNESS_ACCENT} />,
      icon3: <FaFingerprint size={22} color="rgba(35,220,200,0.6)" />,
      title: t("security.randomness.title", { defaultValue: "Verify device randomness" }),
      lead: t("security.randomness.lead", {
        defaultValue:
          "Every wallet begins with randomness. If the generator is broken, every key it creates can be predicted. This audit checks that it behaves like real randomness — before you trust it with money.",
      }),
      bullets: [
        {
          tone: "can",
          text: t("security.randomness.can", {
            defaultValue: "Detects a generator that is stuck, repeating, or visibly biased.",
          }),
        },
        {
          tone: "cannot",
          text: t("security.randomness.cannot", {
            defaultValue: "Cannot prove the randomness is unpredictable — no output test can.",
          }),
        },
        {
          tone: "cannot",
          text: t("security.randomness.more", {
            defaultValue: "For more assurance, add your own dice on the next step.",
          }),
        },
      ],
      actionLabel: t("security.randomness.action", { defaultValue: "Run the audit" }),
      skipLabel: t("security.randomness.skip", { defaultValue: "Skip — trust the device" }),
    },
    dice: {
      accent: DICE_ACCENT,
      icon1: <FaDice size={28} color={DICE_ACCENT} />,
      icon2: <DiceFaces accent={DICE_ACCENT} />,
      icon3: <FaLock size={22} color="rgba(139,92,246,0.6)" />,
      title: t("security.dice.title", { defaultValue: "Add your own dice rolls" }),
      lead: t("security.dice.lead", {
        defaultValue:
          "Roll a physical die and enter the results on the device itself. They are mixed into the seed alongside the device's own randomness, so the wallet does not depend on the generator alone.",
      }),
      bullets: [
        {
          tone: "can",
          text: t("security.dice.can", {
            defaultValue: `You enter ${rollCount} rolls with the device button — they never touch this computer.`,
          }),
        },
        {
          tone: "can",
          text: t("security.dice.can2", {
            defaultValue: "Even a faulty generator cannot make the seed guessable on its own.",
          }),
        },
        {
          tone: "cannot",
          text: t("security.dice.cannot", {
            defaultValue: "Takes a few minutes. Skip it and the device supplies all the randomness.",
          }),
        },
      ],
      actionLabel: t("security.dice.action", { defaultValue: "Use my dice" }),
      skipLabel: t("security.dice.skip", { defaultValue: "Skip — device randomness only" }),
    },
  }

  const d = defs[step]

  return (
    <VStack gap={4} w="100%" maxW="400px" mx="auto">
      <Box
        w="100%"
        bg="rgba(255,255,255,0.03)"
        border="1px solid"
        borderColor={`${d.accent}33`}
        borderRadius="2xl"
        p={6}
        position="relative"
        overflow="hidden"
      >
        <Box
          position="absolute"
          top="-50px"
          right="-50px"
          w="150px"
          h="150px"
          borderRadius="full"
          bg={`${d.accent}08`}
          filter="blur(40px)"
        />

        <VStack gap={4}>
          <HStack gap={6} justify="center" align="center">
            <Box opacity={0.7}>{d.icon3}</Box>
            <Box>{d.icon1}</Box>
            <Box>{d.icon2}</Box>
          </HStack>

          <Text fontSize="xl" fontWeight="800" color="white" textAlign="center" letterSpacing="-0.02em">
            {d.title}
          </Text>

          <Text fontSize="sm" color="gray.400" textAlign="center" lineHeight="1.6" maxW="340px">
            {d.lead}
          </Text>

          <VStack gap="1.5" w="100%" pt={1} align="stretch">
            {d.bullets.map((b) => (
              <Flex key={b.text} gap="2.5" align="flex-start">
                <Box
                  mt="5px"
                  w="7px"
                  h="7px"
                  flexShrink={0}
                  borderRadius="full"
                  bg={b.tone === "can" ? d.accent : "transparent"}
                  border="1px solid"
                  borderColor={b.tone === "can" ? d.accent : "rgba(255,255,255,0.28)"}
                />
                <Text fontSize="xs" color="gray.400" lineHeight="1.55">
                  {b.text}
                </Text>
              </Flex>
            ))}
          </VStack>
        </VStack>
      </Box>

      <VStack gap={2} w="100%">
        <Button
          w="100%"
          size="md"
          bg={d.accent}
          color="black"
          fontWeight="700"
          _hover={{ opacity: 0.9, transform: "translateY(-1px)", boxShadow: `0 4px 16px ${d.accent}40` }}
          _active={{ transform: "scale(0.98)" }}
          transition="all 0.15s ease"
          onClick={onAccept}
        >
          <HStack gap={2} justify="center">
            <Text>{d.actionLabel}</Text>
            <FaChevronRight size={10} />
          </HStack>
        </Button>
        <Button w="100%" size="sm" variant="ghost" color="gray.500" fontWeight="500" onClick={onSkip}>
          {d.skipLabel}
        </Button>
      </VStack>
    </VStack>
  )
}
