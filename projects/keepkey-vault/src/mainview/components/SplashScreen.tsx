import { Box, Text, Flex, Spinner } from "@chakra-ui/react"
import { Logo } from './logo/Logo'
import { EllipsisDots } from "./util/EllipsisSpinner"
import splashBg from '../assets/splash-bg.png'

export function SplashScreen({ statusText, hintText, children }: { statusText: string; hintText?: string; children?: React.ReactNode }) {
  return (
    <Box
      height="100vh"
      width="100vw"
      backgroundImage={`url(${splashBg})`}
      backgroundSize="cover"
      backgroundPosition="center"
      position="relative"
    >
      <Flex
        height="100%"
        width="100%"
        direction="column"
        alignItems="center"
        justifyContent="center"
      >
        <Logo
          width="100px"
          style={{
            filter: 'brightness(1.3)',
            transition: 'filter 0.2s ease'
          }}
        />
      </Flex>
      <Box
        position="absolute"
        bottom="40px"
        left="50%"
        transform="translateX(-50%)"
        textAlign="center"
        width="auto"
        px={3}
        py={1}
        borderRadius="md"
        bg="rgba(0, 0, 0, 0.5)"
      >
        <Flex gap="2" justifyContent="center" alignItems="center">
          <Spinner size="xs" color="gray.400" />
          <Text fontSize="xs" color="gray.300">
            {statusText}
          </Text>
          <EllipsisDots interval={300} />
        </Flex>
        {hintText && (
          <Text fontSize="xs" color="gray.500" mt={2} maxW="340px" textAlign="center">
            {hintText}
          </Text>
        )}
      </Box>
      {children}
    </Box>
  )
}
