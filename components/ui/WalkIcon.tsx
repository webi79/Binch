import Svg, { Circle, Path } from "react-native-svg";

/**
 * Das Geh-Symbol der App — eine laufende Figur.
 *
 * Stand bis eben nur im Kopf des Haltestellen-Blatts („164 m entfernt"). Die
 * Verbindungszeilen des Stadt-Blatts zeigen Fußwege mit demselben Zeichen, so
 * wie Google Maps seine Figur vor die Gehminuten setzt; beide nehmen jetzt
 * dieses eine Symbol.
 */
export function WalkIcon({ size = 14, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={13} cy={4.5} r={1.6} fill={color} />
      <Path
        d="M11 9l-2.5 2 1 4M11 9l3 1 1.5 3M11 9l-1 5-2 5M12.5 18l1.5 3"
        stroke={color}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
