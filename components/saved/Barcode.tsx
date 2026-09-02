/**
 * Barcode-Platzhalter — deterministisch aus dem Ticket-Code generiert.
 * Sieht aus wie ein echter Strichcode, ist aber NICHT scanbar (kein
 * Code128/PDF417-Encoding). Für echte scanbare Codes muss generateBars()
 * durch eine Barcode-Lib ersetzt werden — Optik/Maße bleiben gleich.
 */
import { useMemo } from "react";
import Svg, { Rect } from "react-native-svg";

function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h || 1;
}

function generateBars(seed: number, targetWidth = 296) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  while (x < targetWidth) {
    const w = 1 + Math.floor(rnd() * 4);
    if (rnd() > 0.42) bars.push({ x, w });
    x += w + (1 + Math.floor(rnd() * 2));
  }
  return { bars, total: x };
}

interface Props {
  value: string;
  height?: number;
  color?: string;
}

export function Barcode({ value, height = 66, color = "#0D0D0D" }: Props) {
  const { bars, total } = useMemo(() => generateBars(hashCode(value)), [value]);
  return (
    <Svg
      width="100%"
      height={height}
      viewBox={`0 0 ${total} 100`}
      preserveAspectRatio="none"
    >
      {bars.map((b) => (
        <Rect key={b.x} x={b.x} y={0} width={b.w} height={100} fill={color} />
      ))}
    </Svg>
  );
}
