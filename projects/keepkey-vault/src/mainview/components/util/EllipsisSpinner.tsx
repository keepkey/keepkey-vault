import { useEffect, useState } from "react";
import { Text } from "@chakra-ui/react";

interface EllipsisDotsProps {
    interval?: number;
    color?: string;
}

export const EllipsisDots: React.FC<EllipsisDotsProps> = ({
    interval = 300,
    color = "currentColor",
}) => {
    const [step, setStep] = useState(1);

    useEffect(() => {
        const id = setInterval(
            () => setStep((s) => (s === 3 ? 1 : s + 1)),
            interval
        );
        return () => clearInterval(id);
    }, [interval]);

    const dots = ".".repeat(step);

    return (
        <Text
            as="span"
            display="inline-block"
            w="3ch"
            textAlign="left"
            color={color}
        >
            {dots}
        </Text>
    );
};
