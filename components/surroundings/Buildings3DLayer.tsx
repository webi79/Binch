import { Layer } from "@maplibre/maplibre-react-native";
import { DARK_PALETTE, LIGHT_PALETTE } from "@/components/surroundings/mapStyle";
import type { ResolvedMapStyle } from "@/lib/theme/mapStyleChoice";

/**
 * Häuser mit Höhe — als eigene Ebene über dem Stil, nicht als vierter Stil.
 *
 * WARUM ALS KIND DER KARTE: Der Stil muss eine STABILE Kennung behalten, sonst
 * lädt MapLibre ihn samt aller Kacheln neu (siehe `mapStyle` an der
 * Kartenfläche). Ein Umschalter, der den Stil austauscht, würde also bei jedem
 * Antippen die ganze Karte neu aufbauen. Eine Ebene dazuzuhängen oder
 * wegzunehmen kostet dagegen nichts weiter als diese eine Ebene.
 *
 * DIE DATEN SIND DA, nachgemessen statt vermutet: Die Kachel-Beschreibung von
 * OpenFreeMap führt an der Ebene `building` die Felder `render_height`,
 * `render_min_height` und `hide_3d`; in einer echten Kachel (Berlin, Zoom 14)
 * stehen 187 Gebäude mit genau diesen Schlüsseln. Und die Bibliothek kann es:
 * `fill-extrusion` ist in ihrer Fassung sowohl im Typ als auch in der nativen
 * Android- und iOS-Umsetzung vorhanden.
 *
 * `hide_3d` ist kein Beiwerk: Das Feld markiert Gebäude, die in der Höhe stören
 * würden — etwa die Hülle über einer Bahnhofshalle, die sonst als Klotz über
 * den Gleisen steht.
 *
 * AB ZOOM 14, weil es darunter keine Gebäudedaten gibt (die Kachel-Beschreibung
 * nennt 13 als frühesten Zoom, geliefert wird ab 14). Eine Ebene, die auf
 * Nichts wartet, kostet trotzdem jeden Durchgang.
 */
export function Buildings3DLayer({
  styleName,
  visible,
}: {
  styleName: ResolvedMapStyle;
  /**
   * Aus heißt UNSICHTBAR, nicht abgebaut — siehe die Begründung an der
   * Einhäng-Stelle in `surroundings.tsx`. Eine abgebaute Ebene ist in dieser
   * Bibliothek der Weg in einen Absturz.
   */
  visible: boolean;
}) {
  /**
   * Die Farbe kommt aus derselben Palette wie die flache Gebäude-Fläche, damit
   * beide zusammengehören. Im Luftbild-Modus gibt es keine Palette dafür —
   * dort nimmt ein neutrales, leicht durchsichtiges Grau die Häuser aus dem
   * Bild heraus, ohne es zu übermalen.
   */
  const color =
    styleName === "satellite"
      ? "#9AA0A6"
      : styleName === "light"
        ? LIGHT_PALETTE.building
        : DARK_PALETTE.building;

  return (
    <Layer
      id="building-3d"
      /**
       * FEST unter die Ortsnamen — nicht „nach Mount-Reihenfolge".
       *
       * Erst stand diese Ebene einfach früher im Baum als die Nadeln, in der
       * Annahme, das genüge. Auf dem Gerät tat es das nicht: Die Häuser lagen
       * über den Haltestellen und haben sie ab Zoom 14 zugeschattet. Die
       * Einhäng-Reihenfolge von Kind-Ebenen ist offenbar keine verlässliche
       * Zusage.
       *
       * `beforeId` ist eine: Die Ebene kommt UNTER die genannte. `place-city`
       * ist eine Beschriftungs-Ebene und liegt im Stil ganz oben — alles, was
       * darunter eingehängt wird, liegt damit auch unter den Nadeln, die die
       * Karte erst danach obenauf legt. Nebenbei ist das die richtige
       * Kartenordnung: Häuser über Straßen, Schrift über allem.
       */
      beforeId="place-city"
      type="fill-extrusion"
      source="openmaptiles"
      source-layer="building"
      minzoom={14}
      filter={["!=", ["get", "hide_3d"], true]}
      layout={{ visibility: visible ? "visible" : "none" }}
      paint={{
        "fill-extrusion-color": color,
        "fill-extrusion-height": ["get", "render_height"],
        /** Gebäude auf Stelzen oder Brücken beginnen nicht bei null. */
        "fill-extrusion-base": ["get", "render_min_height"],
        /**
         * Leicht durchsichtig — bei voller Deckung verschluckt eine Häuserzeile
         * die Straßennamen dahinter, und die Karte wird als Karte schlechter,
         * während sie als Bild besser aussieht.
         */
        "fill-extrusion-opacity": 0.8,
      }}
    />
  );
}
