import { Dimensions, StyleSheet } from "react-native";

/**
 * Maße für kleine Geräte herunterrechnen.
 *
 * Sämtliche Größen im Projekt stehen fest in den Stilblättern — ausgelegt auf
 * ein Gerät mit rund 900 Punkten Höhe. Auf einem kurzen Bildschirm (viele
 * Android-Geräte liegen bei 640 bis 760) frisst dieselbe Zahl einen deutlich
 * größeren Anteil: Ein 220 Punkte hoher Hero ist dort ein Drittel des Bildes
 * statt einem Viertel. Genau das ist der Eindruck „wirkt zu groß" — nicht die
 * einzelne Schriftgröße, sondern das Verhältnis.
 *
 * Deshalb wird an der HÖHE gemessen, nicht an der Breite: Zu groß wirkt es,
 * weil zu wenig aufs Bild passt.
 *
 * Der Faktor ist bewusst gedeckelt:
 *
 *  - nach oben auf 1, damit große Geräte unverändert bleiben. Aufblasen wäre
 *    eine andere Entscheidung und gehört nicht hierher.
 *  - nach unten auf 0,80. Die empfohlene Mindestgröße für eine Tippfläche liegt
 *    bei 44 Punkten, und aus den 56 der Eingabefelder werden damit noch 45 —
 *    knapp darüber. Tiefer geht es deshalb nicht.
 */
const REFERENCE_HEIGHT = 900;
const MIN_SCALE = 0.8;

/**
 * EINMAL beim Laden bestimmt — und aus der FENSTER-Höhe.
 *
 * Beide Hälften dieses Satzes waren schon einmal falsch:
 *
 *  - Als HOOK wäre der Wert in einem Stilblatt gar nicht zu gebrauchen. Die
 *    liegen auf Modulebene und werden einmal beim Laden gebaut — genau dort
 *    stehen die Zahlen, um die es geht.
 *  - Aus der GERÄTE-Höhe gelesen war er zu schwach. Sie enthält Status- und
 *    Navigationsleiste, ist also rund 70 Punkte größer als das, was tatsächlich
 *    zur Verfügung steht. Auf einem üblichen Gerät kam damit 0,97 heraus statt
 *    0,89 — praktisch keine Wirkung, obwohl der Platz derselbe geblieben ist.
 *    Maßgeblich ist der Raum, in dem gezeichnet wird, nicht das Glas.
 *
 * Dass die Fenster-Höhe unter `adjustResize` mit der Tastatur schrumpft, spielt
 * hier keine Rolle: Gelesen wird sie ein einziges Mal beim Laden des Moduls,
 * lange vor der ersten Eingabe. Und die Ausrichtung ist auf Hochkant festgelegt
 * (`app.config.js`), sie ändert sich also auch sonst nicht.
 */
export const UI_SCALE = Math.min(
  1,
  Math.max(MIN_SCALE, Dimensions.get("window").height / REFERENCE_HEIGHT),
);

/** Kurzer Bildschirm — für Fälle, die einen Schalter statt eines Faktors brauchen. */
export const IS_COMPACT = UI_SCALE < 0.97;

/**
 * Ein Maß herunterrechnen. Gerundet, weil halbe Punkte auf Android zu
 * unsauberen Kanten führen.
 */
export function ms(value: number): number {
  return Math.round(value * UI_SCALE);
}

/**
 * Schrift geht denselben Weg, aber nur zu 75% mit.
 *
 * Flächen dürfen anteilig schrumpfen, Text nicht im selben Maß: Er wird dadurch
 * nicht kleiner wahrgenommen, sondern schlechter lesbar — die Zeilenlänge
 * bleibt ja gleich. Abgeschwächt rückt der Satz mit, ohne dass aus einer
 * 22er-Überschrift eine 17er wird.
 *
 * Von 60% auf 75% nachgezogen: Kräftige Schnitte (700er Titel) wirken auf einem
 * kurzen Bildschirm schwerer als sie sind, weil um sie herum alles enger steht.
 * Bei 60% blieb der Titel des Ticket-Knopfes praktisch unverändert, während
 * sein Rahmen schrumpfte — er wirkte dadurch fetter statt kleiner.
 */
export function fs(value: number): number {
  return Math.round(value * (1 + (UI_SCALE - 1) * 0.75));
}

/**
 * Welche Eigenschaften mitskaliert werden — als ERLAUBNIS-Liste, nicht als
 * Verbotsliste.
 *
 * Eine Verbotsliste ist hier die falsche Richtung: Was man vergisst, wird
 * stillschweigend mitskaliert, und einiges verträgt das überhaupt nicht.
 * `borderWidth: 1` würde zu 0,8 und damit auf manchen Geräten zur
 * verschwindenden Haarlinie; `elevation` ist eine Schattenstufe, keine Strecke;
 * `flex`, `opacity` und `zIndex` sind gar keine Maße.
 *
 * Schriftgrößen und Zeilenhöhen stehen bewusst NICHT hier — die gehen über
 * `fs()` und damit über eine andere Kurve.
 */
const SCALED_PROPS = new Set([
  "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
  "top", "right", "bottom", "left",
  "margin", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "marginHorizontal", "marginVertical", "marginStart", "marginEnd",
  "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "paddingHorizontal", "paddingVertical", "paddingStart", "paddingEnd",
  "gap", "rowGap", "columnGap", "borderRadius",
  "borderTopLeftRadius", "borderTopRightRadius",
  "borderBottomLeftRadius", "borderBottomRightRadius",
]);

const FONT_PROPS = new Set(["fontSize", "lineHeight"]);

/**
 * `StyleSheet.create` mit Skalierung — ein Aufruf statt hunderter Einzelmaße.
 *
 * Der Grund für diesen Weg ist nicht Bequemlichkeit, sondern Verlässlichkeit:
 * Innerhalb eines Bildschirms müssen ALLE Maße denselben Faktor bekommen. Zieht
 * man einzelne von Hand heraus, verschieben sich Ausrichtungen, die über mehrere
 * Werte aufgebaut sind — und davon gibt es hier reichlich (Zeitspalte plus
 * Abstand plus halber Punkt für die Schienen-Mitte, um ein Beispiel aus dem
 * Streckenblatt zu nehmen). Alles oder nichts ist hier die sichere Wahl.
 *
 * Prozentwerte, `"auto"` und andere Zeichenketten bleiben unberührt: Die sind
 * bereits relativ.
 */
export function scaledStyles<T extends StyleSheet.NamedStyles<T>>(styles: T): T {
  if (UI_SCALE === 1) return StyleSheet.create(styles);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, rule] of Object.entries(styles)) {
    const next: Record<string, unknown> = {};
    for (const [prop, value] of Object.entries(rule as Record<string, unknown>)) {
      if (typeof value === "number" && SCALED_PROPS.has(prop)) next[prop] = ms(value);
      else if (typeof value === "number" && FONT_PROPS.has(prop)) next[prop] = fs(value);
      else next[prop] = value;
    }
    out[name] = next;
  }
  return StyleSheet.create(out as unknown as T);
}

/** Hook-Form für Komponenten — dieselben Zahlen, nur zur Hand. */
export function useCompact() {
  return { small: IS_COMPACT, scale: UI_SCALE, ms, fs };
}
