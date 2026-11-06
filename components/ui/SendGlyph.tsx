/**
 * Das Senden-Zeichen — ein GEFÜLLTER Papierflieger, optisch mittig.
 *
 * Gefüllt („füll den Pfeil", 05.11.2026): lucides `send`-Umriss als Fläche,
 * die Faltlinie als schmaler Schnitt in der Farbe des Knopfes — so liest er
 * sich weiter als Flieger und nicht als Pfeilspitze.
 *
 * MITTE: Der Flieger ist an der Diagonale gespiegelt, also ist nur die Lage
 * ENTLANG dieser Achse offen. Zwei Antworten liegen nahe, beide sahen am Gerät
 * falsch aus:
 *  - Umriss-Mitte (lucide, unverschoben): Spitze und Masse ziehen nach rechts
 *    oben („das sieht überhaupt nicht mittig aus", 04.11.2026).
 *  - Flächen-Schwerpunkt (13,30 | 10,65): der Umriss rutscht sichtbar nach
 *    links unten („alles andere als richtig positioniert", 05.11.2026).
 * Gesetzt ist deshalb der halbe Weg dazwischen (12,65 | 11,32) — gemessen am
 * gerenderten Zeichen (Schnitt und Rundung eingerechnet) und in allen drei
 * Knopfgrößen nebeneinander geprüft. Wie beim Abspiel-Dreieck: weder reine
 * Box noch reiner Schwerpunkt.
 *
 * Verschoben wird über den Ausschnitt (`viewBox`), nicht über eine
 * Verwandlung — das Zeichen bleibt ein einziges ruhiges Bild.
 * Eine Quelle für alle Senden-Knöpfe der App.
 */
import Svg, { Path } from "react-native-svg";

/** lucide `send`: Umriss des Fliegers und seine Faltlinie (24er-Raster). */
const BODY =
  "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z";
const FOLD = "m21.854 2.147-10.94 10.939";
/** Optische Mitte im 24er-Raster (siehe oben) → Ausschnitt so, dass sie in der Mitte liegt. */
const VIEW_BOX = `${(12.651 - 12).toFixed(3)} ${(11.324 - 12).toFixed(3)} 24 24`;

export function SendGlyph({
  size,
  color,
  cutColor,
}: {
  size: number;
  /** Farbe des Fliegers. */
  color: string;
  /** Farbe des Knopfes dahinter — die Faltlinie ist ein Schnitt in genau dieser Farbe. */
  cutColor: string;
}) {
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX}>
      {/* Fläche plus gleichfarbiger Rand: rundet die Spitzen wie bei den übrigen Zeichen. */}
      <Path d={BODY} fill={color} stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      <Path d={FOLD} fill="none" stroke={cutColor} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}
