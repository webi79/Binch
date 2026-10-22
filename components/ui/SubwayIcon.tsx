import { forwardRef } from "react";
import Svg, { Path, Rect } from "react-native-svg";
import type { LucideIcon, LucideProps } from "lucide-react-native";

/**
 * „U" für die U-Bahn — so kennzeichnet man U-Bahnen (blaues Schild, weißes U),
 * auf der Karte (`marker-box-subway`) wie in Listen und Suche. Im Raster und
 * Strich der Lucide-Symbole (24er, Strich 2), damit es neben Train, Bus und Ship
 * nicht aus der Reihe fällt; nimmt dieselben Eigenschaften (`color`, `size`,
 * `strokeWidth`) und steht deshalb überall dort, wo sonst ein Lucide-Symbol steht.
 */
export const SubwayIcon = forwardRef<Svg, LucideProps>(function SubwayIcon(
  { color = "currentColor", size = 24, strokeWidth = 2 },
  ref,
) {
  return (
    <Svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      color={color}
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Rect x={3} y={3} width={18} height={18} rx={4} />
      {/* Mit den runden Strich-Enden genau mittig im Rahmen (6,9 bis 17). */}
      <Path d="M8.5 7.9v4.6a3.5 3.5 0 0 0 7 0V7.9" />
    </Svg>
  );
}) as unknown as LucideIcon;
