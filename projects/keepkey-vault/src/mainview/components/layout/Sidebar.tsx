import { Box, VStack, Text, Flex } from "@chakra-ui/react";
import { useLocation, useNavigate } from "react-router-dom";
import {
	MdDashboard,
	MdAccountBalanceWallet,
	MdEdit,
	MdDevices,
	MdSettings,
} from "react-icons/md";
import type { IconType } from "react-icons";

interface NavItem {
	label: string;
	path: string;
	icon: IconType;
}

const NAV_ITEMS: NavItem[] = [
	{ label: "Dashboard", path: "/", icon: MdDashboard },
	{ label: "Addresses", path: "/addresses", icon: MdAccountBalanceWallet },
	{ label: "Sign", path: "/sign", icon: MdEdit },
	{ label: "Device", path: "/device", icon: MdDevices },
	{ label: "Settings", path: "/settings", icon: MdSettings },
];

export function Sidebar() {
	const location = useLocation();
	const navigate = useNavigate();

	return (
		<Box
			position="fixed"
			left="0"
			top="56px"
			bottom="32px"
			w="220px"
			bg="kk.cardBg"
			borderRight="1px solid"
			borderColor="kk.border"
			py="4"
			zIndex="90"
		>
			<VStack gap="1" px="3">
				{NAV_ITEMS.map((item) => {
					const active = location.pathname === item.path;
					const Icon = item.icon;
					return (
						<Flex
							key={item.path}
							onClick={() => navigate(item.path)}
							w="100%"
							px="3"
							py="2.5"
							borderRadius="lg"
							cursor="pointer"
							alignItems="center"
							gap="3"
							bg={active ? "rgba(255, 215, 0, 0.1)" : "transparent"}
							color={active ? "kk.gold" : "kk.textSecondary"}
							borderLeft={active ? "3px solid" : "3px solid transparent"}
							borderLeftColor={active ? "kk.gold" : "transparent"}
							_hover={{
								bg: active ? "rgba(255, 215, 0, 0.1)" : "kk.cardBgHover",
								color: active ? "kk.gold" : "kk.textPrimary",
							}}
							transition="all 0.15s ease"
						>
							<Icon size={18} />
							<Text fontSize="sm" fontWeight={active ? "semibold" : "normal"}>
								{item.label}
							</Text>
						</Flex>
					);
				})}
			</VStack>
		</Box>
	);
}
