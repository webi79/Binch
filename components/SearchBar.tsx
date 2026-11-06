import { useCallback, useEffect, useRef } from "react";
import { Text, TextInput, StyleSheet, View, type StyleProp, type ViewStyle, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { Mic, Search as SearchIcon } from "lucide-react-native";
import { useT } from "@/lib/i18n/useT";
import { usePalette } from "@/lib/theme/appBg";
import { useAccent } from "@/lib/theme/accent";
import { useSearchStore } from "@/stores/searchStore";
import { GradientFill } from "@/components/ui/GradientFill";
import {
  RotatingPlaceholder,
  RotatingText,
  type RotatingPlaceholderHandle,
  type RotationTiming,
} from "@/components/home/RotatingPlaceholder";
import { useHintPause } from "@/lib/ui/hintPause";
import { MiniBo, type MiniBoHandle } from "@/components/home/MiniBo";
import { scaledStyles } from "@/lib/ui/compact";

/**
 * WARUM DIESE LEISTE KEINE DRUCK-RÜCKMELDUNG TRÄGT.
 *
 * Ich hatte hier eine eingebaut — ein leichtes Zusammendrücken über einen
 * geteilten Wert, ausgelöst beim Aufsetzen, wie bei den vier Launch-Kacheln.
 * Die Rechnung dahinter stimmt weiterhin: Zwischen Loslassen und dem ersten
 * SICHTBAREN Bild der Fahrt vergehen rund 80 bis 110ms, in denen nichts
 * passiert, und eine Rückmeldung im nächsten Bild würde die genau füllen.
 *
 * Am Gerät sah es trotzdem schlechter aus, und der Grund steht schon in dieser
 * Datei, nur ein paar Zeilen weiter unten: Diese Leiste enthält den
 * Mikrofon-Knopf, und der ist ein SVG mit Verlauf. Eine Skalierung darüber ist
 * keine billige Verschiebung — sie macht die Fläche in jedem Bild ungültig und
 * lässt das SVG neu rastern. Dieselbe Falle, aus der die Material-Welle hier
 * schon einmal entfernt wurde, nur mit anderem Auslöser.
 *
 * Die Rückmeldung müsste also ohne Skalierung und ohne Deckkraft AUF dieser
 * Fläche auskommen — sonst ist der Gewinn an Direktheit teurer als das, was er
 * kaschieren soll.
 */
const COLORS = {
  surface: "#171719",
  // lime entfernt — GradientFill liest den User-Akzent via useAccent().
  black: "#000000",
  white: "#F4F4F5",
  gray2: "#8E8E93",
  gray3: "#56565C",
};

interface CommonProps {
  /** i18n key for the placeholder. Defaults to `home.search.placeholder`. */
  placeholderKey?: string;
  /** Optional leading label (e.g. "From", "To") rendered before the input. */
  leadingLabel?: string;
  /** Hide the mic button (e.g. inside the voice screen itself). */
  showMic?: boolean;
  /** Override the mic-button action (defaults to `/search/voice`). */
  onMicPress?: () => void;
  /** Extra style applied to the outer pill (margins/positioning). */
  style?: StyleProp<ViewStyle>;
}

interface PressProps extends CommonProps {
  /** Tap handler. If not given, navigates to `/search`. */
  onPress?: () => void;
  /**
   * Rohes Berührungs-Ereignis, durchgereicht an den Knopf.
   *
   * Für Vorbereitungen, die schon beim Aufsetzen laufen müssen — etwa das
   * Anlegen einer GPU-Ebene, deren Aufbau nicht in den Start einer Bewegung
   * fallen darf.
   */
  onTouchStart?: () => void;
  /**
   * Wechselnde Sprüche statt des festen Platzhalters — nur der Landingscreen
   * schaltet das ein. Karte und Ortswähler bleiben bei der festen Zeile.
   * Wie und warum: `components/home/RotatingPlaceholder.tsx`.
   */
  rotatePlaceholder?: boolean;
  /**
   * Der kleine, lebendige Bo statt der Lupe — wie die Sprüche nur auf dem
   * Landingscreen. Karte, Ortswähler und der Eingabe-Modus behalten die Lupe.
   * Wie und warum: `components/home/MiniBo.tsx`.
   */
  mascot?: boolean;
  value?: undefined;
  onChangeText?: undefined;
  autoFocus?: undefined;
}

interface InputProps extends CommonProps {
  /** Controlled value — switches the bar into text-input mode. */
  value: string;
  onChangeText: (text: string) => void;
  autoFocus?: boolean;
  /** Delay (ms) bevor der Focus auf das Input gesetzt wird. Nützlich wenn
   *  der SearchBar in einem Modal/Slide-In sitzt — sofortiges autoFocus
   *  triggert das Keyboard parallel zum Slide, was auf Android beim ersten
   *  Mal spürbares Lag macht. Mit Delay startet das Keyboard erst NACH dem
   *  Slide. */
  autoFocusDelay?: number;
  /**
   * Wechselnde Hinweise im LEEREN Feld (Ortswähler) — dieselbe Bewegung wie
   * die Sprüche des Landingscreens, nur mit viel mehr Ruhe dazwischen
   * (`HINT_TIMING`). Der erste Satz steht zuerst (der bisherige Platzhalter).
   */
  hintKeys?: readonly string[];
  /** Darf gerade gewechselt werden? Der Aufrufer weiß, wann das Feld steht und zu sehen ist. */
  hintsActive?: boolean;
  /** Neu beginnen — erster Satz zuerst —, sobald sich das ändert (neue Öffnung). */
  hintsSession?: string | number;
  onPress?: undefined;
  rotatePlaceholder?: undefined;
  mascot?: undefined;
}

type Props = PressProps | InputProps;

/*
 * Die statische Vorlage `BoMark`, die hier stand, ist in `MiniBo` aufgegangen
 * (`components/home/MiniBo.tsx`): dieselben Pfaddaten aus Bo.tsx, jetzt
 * lebendig. Ihre Umkehr-Farben (dunkler Körper, helles Gesicht) gelten dort für
 * helle Leisten. Die Augen sind dort wieder Bos hohe Ellipsen — in der
 * Vorschau auf 17 dp lesen sie sich nicht als Schlitze, sondern als Bo.
 */

/**
 * Das Mikrofon im Akzent-Knopf.
 *
 * Größe und Strich wie die Lupe derselben Leiste (18, Strich 2): Zwei Symbole
 * einer Zeile in verschiedenen Stärken sehen nach zwei Quellen aus.
 *
 * Tinte `textOnSolid` statt fest Schwarz — die Palette legt fest, was auf ihrer
 * Fläche lesbar bleibt. Heute ist das Schwarz: 13,8:1 auf Lime, 12,4:1 auf Mint;
 * Weiß käme auf beiden nicht über 1,7:1. Ein späterer dunkler Akzent bringt so
 * seine eigene Tinte mit.
 *
 * Eigene Komponente, damit ein Akzent-Wechsel nur sie neu zeichnet und nicht
 * die ganze Leiste — dieselbe Aufteilung wie bei `GradientFill`.
 */
function MicGlyph() {
  const accent = useAccent();
  return <Mic size={18} color={accent.textOnSolid} strokeWidth={2} />;
}

export function SearchBar(props: Props) {
  const palette = usePalette();
  const t = useT();
  const router = useRouter();
  const openVoiceOverlay = useSearchStore((s) => s.openVoiceOverlay);
  const inputRef = useRef<TextInput>(null);
  const rotatorRef = useRef<RotatingPlaceholderHandle>(null);
  const boRef = useRef<MiniBoHandle>(null);
  /** Ein Spruch steht und die Leiste ist still — Bos Fenster (siehe MiniBo). */
  const cueBo = useCallback((key: string) => boRef.current?.cue(key), []);

  // Verzögertes autoFocus: wenn autoFocusDelay gesetzt ist, fokussieren
  // wir manuell via setTimeout statt mit nativem autoFocus-Prop. Damit
  // wird der Keyboard-Cold-Start nicht parallel zum Slide-In ausgeführt.
  // Außerdem reagiert das Effect auch wenn autoFocus von false→true togglet
  // (z.B. weil ein parent-Overlay sichtbar wird) → wir können dann ein
  // immer-gemountetes Picker-Overlay realisieren.
  /**
   * Wechselnde Hinweise im Eingabefeld — nur, solange es leer ist und der
   * Aufrufer das Wechseln erlaubt. Immer aufgerufen (Hook-Regel); ohne Hinweise
   * hält er nichts.
   */
  const hintKeys = "hintKeys" in props ? props.hintKeys : undefined;
  const hints = props.value !== undefined && hintKeys !== undefined && hintKeys.length > 1;
  const hintPause = useHintPause(
    hints && "hintsActive" in props && props.hintsActive === true && props.value === "",
  );
  const inputAutoFocusDelay =
    "autoFocusDelay" in props ? props.autoFocusDelay : undefined;
  const inputAutoFocus = "autoFocus" in props ? props.autoFocus : undefined;
  const hasInputValue = props.value !== undefined;
  useEffect(() => {
    if (!hasInputValue) return;
    if (inputAutoFocus !== true) {
      // autoFocus=false oder undefined → Input blur (z.B. wenn Overlay
      // unsichtbar wird) damit das Keyboard sich schließt.
      inputRef.current?.blur();
      return;
    }
    if (inputAutoFocusDelay === undefined) {
      // Nativer autoFocus übernimmt — der useEffect macht hier nichts.
      return;
    }
    const id = setTimeout(() => {
      inputRef.current?.focus();
    }, inputAutoFocusDelay);
    return () => clearTimeout(id);
  }, [hasInputValue, inputAutoFocus, inputAutoFocusDelay]);
  const {
    placeholderKey = "home.search.placeholder",
    leadingLabel,
    showMic = true,
    onMicPress,
    style,
  } = props;

  const isInput = "value" in props && props.value !== undefined;
  const placeholder = t(placeholderKey);

  const mic = showMic ? (
    // Auch hier keine Welle: Der Mikrofon-Knopf öffnet Bo genauso — siehe unten.
    <Pressable
      style={styles.micButton}
      hitSlop={6}
      onPress={(e) => {
        e.stopPropagation?.();
        if (onMicPress) onMicPress();
        else openVoiceOverlay();
      }}
      accessibilityLabel={t("mode.voice")}
    >
      <GradientFill />
      {/* Wieder das Mikrofon statt Bo: Der Knopf führt zur Spracheingabe — auf
          dem Landingscreen über Bo, der nach seiner Einfahrt die Aufnahme
          startet. Genau das soll man ihm ansehen. */}
      <MicGlyph />
    </Pressable>
  ) : null;

  if (isInput) {
    const input = (
      <TextInput
        ref={inputRef}
        value={props.value}
        onChangeText={props.onChangeText}
        // Mit Hinweisen trägt die Ebene darunter den Platzhalter — für
        // Vorleser bleibt er als Label am Feld (die Ebene ist für sie stumm).
        placeholder={hints ? undefined : placeholder}
        accessibilityLabel={hints ? placeholder : undefined}
        placeholderTextColor={COLORS.gray3}
        style={hints ? styles.inputFlush : styles.input}
        autoCorrect={false}
        // Nativer autoFocus nur wenn KEIN Delay konfiguriert ist.
        // Sonst übernimmt der useEffect oben das Fokussieren.
        autoFocus={inputAutoFocus === true && inputAutoFocusDelay === undefined}
      />
    );
    return (
      <View style={[styles.bar, { backgroundColor: palette.s2 }, style]}>
        <SearchIcon size={18} color={COLORS.gray2} />
        {leadingLabel && <Text style={styles.leadingLabel}>{leadingLabel}</Text>}
        {hints ? (
          <View style={styles.inputBox}>
            {/* Hinter dem Feld, ohne Berührungen — und weg, sobald getippt wird. */}
            <View pointerEvents="none" style={[styles.hintLayer, props.value !== "" && styles.hintHidden]}>
              <RotatingText
                key={("hintsSession" in props ? props.hintsSession : undefined) ?? 0}
                keys={hintKeys}
                pause={hintPause}
                timing={HINT_TIMING}
                textStyle={styles.hintText}
              />
            </View>
            {input}
          </View>
        ) : (
          input
        )}
        {mic}
      </View>
    );
  }

  const touchStart = "onTouchStart" in props ? props.onTouchStart : undefined;
  /**
   * Wechselnder Platzhalter: Solange ein Finger auf der Leiste liegt, startet
   * kein Wechsel — aus der Berührung wird meist Bos Einfahrt. Rohe
   * Berührungs-Ereignisse statt `onPressIn`: Sie kommen sofort und auch, wenn
   * der Finger auf dem Mikrofon-Knopf landet.
   *
   * Das Label steht dann fest an der Leiste: Die Sprüche wechseln, und die
   * beiden Ebenen trügen zwei Sätze auf einmal.
   *
   * Der kleine Bo links (`mascot`) hört auf dieselben Berührungen: Kein neuer
   * Moment, solange der Finger liegt — und ein laufender gleitet in die Ruhe,
   * bevor seine große Fassung hereinfährt.
   */
  const rotate = props.rotatePlaceholder === true;
  const mascot = props.mascot === true;
  const watchTouch = rotate || mascot;
  /**
   * Bos Farbe folgt der Fläche, auf der er TATSÄCHLICH steht — samt einer
   * Hintergrundfarbe, die der Aufrufer über `style` setzt.
   */
  const barColor = mascot ? (StyleSheet.flatten(style)?.backgroundColor ?? palette.s2) : undefined;

  /**
   * Schlichtes `Pressable` statt `RippleTouch` — wie die vier Launch-Kacheln
   * im Landingscreen, und aus einem verwandten Grund.
   *
   * Diese Leiste ist der Weg zu Bo. Beim Loslassen startet die Fahrt, und die
   * Material-Welle läuft danach noch rund 300ms weiter — auf einer Fläche,
   * die in genau diesen Bildern nach links wandert. Eine Ansicht, die sich
   * währenddessen selbst ändert, macht die Unterlage in jedem Bild ungültig;
   * das ist der Mikro-Ruckler im Parallax.
   *
   * Und es erklärt, warum das Such-Blatt sich besser anfühlt: Die vier
   * Kacheln, über die man es meistens öffnet, tragen längst keine Welle mehr.
   * Nur der Weg zu Bo hatte noch eine.
   *
   * Die Rückmeldung bleibt — als Abdunkeln beim Drücken statt als laufende
   * Welle. Sie steht sofort und ändert sich danach nicht mehr.
   */
  return (
    <Pressable
      /**
       * ARRAY, keine Funktion.
       *
       * Mit `style={({pressed}) => [...]}` kam hier gar kein Stil an: Die Leiste
       * verlor Pillenform, Hintergrund und Zeilen-Anordnung, der
       * Mikrofon-Knopf zog sich über die volle Breite. Diese Datei geht durch
       * NativeWinds JSX-Umschreibung, und die verträgt sich an dieser Stelle
       * nicht mit der Funktions-Form.
       */
      style={[styles.bar, { backgroundColor: palette.s2 }, style]}
      onPress={props.onPress ?? (() => router.navigate("/search"))}
      onTouchStart={
        watchTouch
          ? () => {
              rotatorRef.current?.hold();
              boRef.current?.hold();
              touchStart?.();
            }
          : touchStart
      }
      onTouchEnd={
        watchTouch
          ? () => {
              rotatorRef.current?.release();
              boRef.current?.release();
            }
          : undefined
      }
      onTouchCancel={
        watchTouch
          ? () => {
              rotatorRef.current?.release();
              boRef.current?.release();
            }
          : undefined
      }
      accessibilityRole={rotate ? "button" : undefined}
      accessibilityLabel={rotate ? placeholder : undefined}
    >
      {mascot ? (
        <MiniBo ref={boRef} surface={barColor} textGap={BAR_GAP} />
      ) : (
        <SearchIcon size={18} color={COLORS.gray2} />
      )}
      {leadingLabel && <Text style={styles.leadingLabel}>{leadingLabel}</Text>}
      {rotate ? (
        <RotatingPlaceholder
          ref={rotatorRef}
          firstKey={placeholderKey}
          textStyle={styles.placeholderText}
          onLineShown={mascot ? cueBo : undefined}
        />
      ) : (
        <Text style={styles.placeholder} numberOfLines={1}>
          {placeholder}
        </Text>
      )}
      {mic}
    </Pressable>
  );
}

/**
 * Der Takt der Hinweise im Ortswähler — mit viel mehr Ruhe als die Sprüche des
 * Landingscreens (3,6 s): Dort lädt eine Leiste zum Tippen ein, hier sucht man
 * gerade einen Ort, und nichts soll dabei stören.
 */
const HINT_TIMING: RotationTiming = { hold: 7500, firstHold: 6000, resumeHold: 4500 };

/**
 * Schrift des Platzhalters — EINMAL, für die feste Zeile und die wechselnden
 * Sprüche. Die wechselnden bekommen sie ohne `flex`: Den trägt dort der
 * Ausschnitt, und an absolut gesetzten Ebenen hätte er nichts verloren.
 */
const PLACEHOLDER_TEXT = {
  fontSize: 14,
  color: COLORS.gray2,
  fontWeight: "400",
  /**
   * 12 im Feld + 8 an der Leiste = die 20 von vorher (je 10): Die Leiste behält
   * ihre Höhe, beide Werte liegen auf dem Raster.
   */
  paddingVertical: 12,
} as const;

const styles = scaledStyles({
  bar: {
    borderRadius: 9999,
    paddingLeft: 16,
    paddingRight: 8,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    /**
     * Die Umrandung steht HIER, nicht an der Aufrufstelle.
     *
     * Sie hing vorher als Inline-Stil am Landingscreen; die Leiste auf der
     * Karte und die im Ortswähler hatten sie deshalb nicht — dieselbe
     * Komponente, drei verschiedene Erscheinungen. Auf der dunklen Karte fehlte
     * damit genau das, was die Leiste vom Grund abhebt, und sie wirkte tiefer
     * als die auf dem Landingscreen, obwohl beide dieselbe Fläche tragen.
     */
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.14)",
  },
  leadingLabel: { fontSize: 14, color: COLORS.white, fontWeight: "500" },
  placeholder: { flex: 1, ...PLACEHOLDER_TEXT },
  placeholderText: PLACEHOLDER_TEXT,
  input: { flex: 1, fontSize: 14, color: COLORS.white, fontWeight: "400", paddingVertical: 12 },
  /**
   * Feld und Hinweise übereinander: dieselbe Schrift, dasselbe senkrechte
   * Polster, links bündig auf 0 — die Hinweise stehen so genau dort, wo der
   * Platzhalter stand und wo getippt wird.
   */
  inputBox: { flex: 1, justifyContent: "center" },
  inputFlush: {
    fontSize: 14,
    color: COLORS.white,
    fontWeight: "400",
    paddingVertical: 12,
    paddingHorizontal: 0,
  },
  hintLayer: { ...StyleSheet.absoluteFillObject, flexDirection: "row" },
  hintHidden: { opacity: 0 },
  hintText: { ...PLACEHOLDER_TEXT, color: COLORS.gray3 },
  micButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});

/**
 * Abstand zwischen Symbol und Platzhalter, wie er auf diesem Gerät gilt
 * (`gap` der Leiste, auf kurzen Geräten kleiner). Der kleine Bo hält seine
 * rechte Kante auf allen Wegen mit Abstand davor — siehe `MiniBo`.
 */
const BAR_GAP = (() => {
  const gap = StyleSheet.flatten(styles.bar).gap;
  return typeof gap === "number" ? gap : 8;
})();
