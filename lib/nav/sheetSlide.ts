import { useCallback, useEffect, useRef } from "react";
import {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { SHEET_IN, SHEET_OUT, markSheetMoving } from "./overlayCover";
import { setSheetMoving } from "./searchHandoff";
import { dragHealOffset, snapToPixel } from "@/lib/ui/sheetSwipe";

/**
 * EINE Fahrt für alle Blätter — von unten wie von oben.
 *
 * Die Richtung steckt allein im VORZEICHEN von `park`: positiv heißt „geparkt
 * unterhalb des Bildrands" (alle Blätter von unten), negativ „geparkt oberhalb"
 * (die Such-Slide der Ergebnisliste). Gefahren wird in beiden Fällen auf 0 zu,
 * es gibt also keinen zweiten Pfad, der auseinanderlaufen könnte — genau darum
 * geht es in dieser Datei.
 *
 * Warum das hier steht und nicht in jedem Blatt einzeln: Weil sie über Monate
 * auseinandergelaufen sind, ohne dass es jemandem auffiel. Zuletzt unterschieden
 * sich Ortswähler, Datumswähler und Such-Blatt in Dauer (250 gegen 300),
 * Strecke (Geräte- gegen Fensterhöhe), Reihenfolge von Parken und Bild-Vorlauf,
 * und darin, ob die Rückfahrt überhaupt eine Ebene bekam. Jede dieser
 * Abweichungen war für sich klein — zusammen ergaben sie den Eindruck „das eine
 * ist elegant, das andere ruckelt".
 *
 * Alles, was die Bewegung ausmacht, steht deshalb genau einmal hier:
 *
 *  - Strecke: die FENSTER-Höhe beim Laden. Nicht die Gerätehöhe (die ist um
 *    Status- und Navigationsleiste größer, das wären bei gleicher Dauer 9% mehr
 *    Tempo), und nicht laufend gelesen (unter `adjustResize` schrumpft sie mit
 *    der Tastatur).
 *  - Kurve und Dauer: `SHEET_IN`/`SHEET_OUT`, dieselben Konstanten wie überall.
 *  - Ablauf: parken, anmelden, EIN Bild zeichnen lassen, dann fahren. Das Bild
 *    dazwischen ist der Unterschied zwischen „die Bewegung läuft gegen den
 *    Aufbau an" und „sie hat den Strang für sich".
 *  - Beide Richtungen gleich aufgebaut. Die Ausfahrt hatte diesen Vorlauf lange
 *    nicht, und genau deshalb war sie die schlechtere von beiden.
 *
 * Die Anmeldung (`markSheetMoving` + `setSheetMoving`) gehört mit hierher: An
 * ihr hängen die Freigabe der GPU-Ebenen und alles, was sich aus einer laufenden
 * Bewegung heraushalten soll. Ein Blatt, das sie vergisst, erzeugt Fehler an
 * ganz anderer Stelle — das ist in dieser Datei mehrfach passiert.
 */
export function useSheetSlide(key: string, park: number) {
  const y = useSharedValue(park);
  /**
   * Die laufende Fahrt als reine JS-Angabe — siehe `from` unten.
   *
   * Reicht aus, um die aktuelle Lage zu SCHÄTZEN, ohne den geteilten Wert zu
   * lesen. Die Kurve ist zwar geglättet, für die Frage „wie viel Weg ist noch
   * übrig" genügt aber der lineare Anteil der verstrichenen Zeit — daraus wird
   * nur die Dauer skaliert, nicht die Position gesetzt.
   */
  const motionRef = useRef<{ from: number; to: number; at: number; dur: number }>({
    from: park,
    to: park,
    at: 0,
    dur: 1,
  });
  const rafRef = useRef<number | null>(null);
  /**
   * Welche Fahrt gerade gilt.
   *
   * Der Abschluss-Rückruf unten stieg bei `finished === false` wortlos aus, und
   * das war lange richtig: Eine neue Fahrt bricht die alte ab, und deren
   * Rückruf hätte sonst den Schlüssel wieder ausgetragen, den die neue eben
   * gesetzt hat.
   *
   * Nur gibt es seit der Wisch-Geste einen zweiten Grund für einen Abbruch: Man
   * fasst das Blatt an, WÄHREND es fährt. Dann kommt keine neue Fahrt, die
   * aufräumt — der Schlüssel bliebe für den Rest des App-Laufs stehen, und an
   * ihm hängt die Freigabe der bildschirmfüllenden Texturen.
   *
   * Die Nummer trennt die beiden Fälle: Abgeräumt wird immer, außer wenn
   * inzwischen eine NEUERE Fahrt losgelaufen ist. Der Zähler liegt auf dem
   * JS-Strang, der geteilte Wert bekommt ihn nur geschrieben — gelesen wird er
   * ausschließlich im Worklet, wo das nichts kostet.
   */
  const genRef = useRef(0);
  const gen = useSharedValue(0);
  /** Läuft eine übernommene Fahrt (siehe `adopt`), meldet dieser Wecker sie ab. */
  const adoptRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearAdopt = useCallback(() => {
    if (adoptRef.current == null) return;
    clearTimeout(adoptRef.current);
    adoptRef.current = null;
  }, []);

  /**
   * Auf ganze Gerätepixel, plus Selbstkorrektur beim Ziehen — beides erklärt
   * in lib/ui/sheetSwipe.ts. `heal` geht an `useSheetSwipe` des Blattes.
   */
  const heal = useSharedValue(0);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: snapToPixel(y.value) + dragHealOffset(heal) }],
  }));

  /**
   * @param show true = hereinfahren, false = hinausfahren
   * @param onFrame läuft im Bild VOR dem Start — für Bewegungen, die im selben
   *        Takt mitlaufen sollen. Derzeit nutzt es niemand; der Haken bleibt,
   *        weil er die einzige Stelle ist, an der so etwas den gleichen Takt
   *        bekommt, ohne eine zweite Quelle aufzumachen.
   */
  const run = useCallback(
    (show: boolean, onFrame?: (show: boolean) => void) => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      // Ein noch laufender Wecker aus `adopt` gehört WEG, bevor diese Fahrt sich
      // anmeldet: Er trüge sonst mitten in ihr denselben Schlüssel wieder aus.
      clearAdopt();
      cancelAnimation(y);
      const cfg = show ? SHEET_IN : SHEET_OUT;
      /**
       * Beim Wiedereintritt aus der Rückfahrt: von der aktuellen Stelle weiter,
       * mit ANTEILIGER Dauer.
       *
       * `withTiming` nimmt die volle Dauer, egal wie kurz der Weg ist. Von
       * halber Höhe aus über 300ms zurückzufahren sieht deshalb aus wie
       * Kriechen. Die Dauer wird darum mit dem verbleibenden Anteil der Strecke
       * skaliert — die Geschwindigkeit bleibt damit dieselbe wie bei einer
       * vollen Fahrt, und der Wiedereintritt fühlt sich an wie deren
       * Fortsetzung. Nach unten begrenzt, sonst zuckt es bei sehr kurzen
       * Wegen.
       */
      /**
       * Der Ausgangspunkt kommt aus einem JS-Merker, NICHT aus `y.value`.
       *
       * Ein Lesezugriff auf einen geteilten Wert ist von JS aus kein
       * Feldzugriff, sondern ein SYNCHRONER Sprung in die UI-Laufzeit, der
       * beide Stränge gegeneinander sperrt. `overlayCover.ts` verbietet das an
       * zwei Stellen wörtlich — und hier stand es unbemerkt in der gemeinsamen
       * Fahrt, also bei jedem Öffnen und Schließen beider Wähler, direkt vor
       * dem Anmelden.
       *
       * Der Merker wird bei jedem Start und jedem Parken fortgeschrieben. Er
       * kann nur dann vom echten Wert abweichen, wenn eine Kurve unterwegs
       * abgebrochen wurde — und für diesen Fall ist eine konservative Schätzung
       * völlig ausreichend: Sie bestimmt allein, wie stark die Dauer bei einer
       * Umkehr gekürzt wird.
       */
      const m = motionRef.current;
      const t = Math.min(1, Math.max(0, (Date.now() - m.at) / m.dur));
      const from = m.from + (m.to - m.from) * t;
      /**
       * Restweg und Gesamtstrecke als BETRAG — beides.
       *
       * Hier stand die Strecke vorzeichenbehaftet, und davor ein `park > 0`.
       * Für ein Blatt von unten geht das auf: `from` liegt zwischen 0 und
       * `park`, beide Differenzen sind positiv, der Anteil stimmt. Für ein Blatt
       * von OBEN ist `park` negativ — der Zähler wird negativ, der Nenner auch,
       * und der Wächter davor schaltet die Kürzung ersatzlos ab. Die Umkehr
       * führe dann IMMER die volle Dauer, also aus zwei Fingerbreit Restweg
       * heraus dieselben 260ms wie über die ganze Strecke. Genau das Kriechen,
       * gegen das der Boden von 0,15 unten gesetzt wurde, nur eine Ebene höher.
       *
       * Der Betrag ist hier das Richtige, weil aus beiden Zahlen ausschließlich
       * ein VERHÄLTNIS wird: „wie viel Weg ist noch übrig". Eine Richtung hat
       * diese Frage nicht — die trägt schon `to` unten. Für positives `park`
       * ändert sich damit nichts: Beide Differenzen waren dort ohnehin nie
       * negativ, `Math.abs` ist auf ihnen die Identität.
       */
      const rest = Math.abs(show ? from : park - from);
      const span = Math.abs(park);
      /**
       * Boden bei 0,15 statt 0,35 — sonst wird die Umkehr ZÄHER, je kürzer sie
       * ist. Bei 35% Mindestdauer für 2% Restweg kriecht das Blatt über einen
       * Fingerbreit. Und angemeldet wird die TATSÄCHLICHE Dauer: Mit der vollen
       * gälte der Bildschirm nach einer 100ms-Umkehr noch 380ms als „fährt",
       * und alles, was darauf wartet, bliebe unnötig lange liegen.
       *
       * `span > 0` bleibt als Division-Wächter stehen — ein Blatt ohne Strecke
       * hat keinen Anteil, den man kürzen könnte.
       */
      const frac = span > 0 ? Math.min(1, Math.max(0.15, rest / span)) : 1;
      const dur = Math.round(cfg.duration * frac);
      const cfgScaled = { duration: dur, easing: cfg.easing };
      markSheetMoving(dur);
      setSheetMoving(true, key);
      genRef.current += 1;
      const myGen = genRef.current;
      gen.value = myGen;
      motionRef.current = { from, to: show ? 0 : park, at: Date.now(), dur: Math.max(1, dur) };
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        onFrame?.(show);
        y.value = withTiming(show ? 0 : park, cfgScaled, (finished) => {
          "worklet";
          // Nicht mehr `if (!finished) return` — siehe `gen`: Auch der Abbruch
          // durch eine Berührung muss den Schlüssel zurückgeben.
          if (gen.value !== myGen) return;
          runOnJS(setSheetMoving)(false, key);
        });
      });
    },
    [clearAdopt, gen, key, park, y],
  );

  /**
   * Den ECHTEN Weg einmal kalt anlaufen lassen.
   *
   * Reanimated übersetzt die Worklets einer Bewegung beim ersten Lauf. Vorher
   * stand in jedem Wähler ein eigener Anlauf mit einer eigenen, winzigen
   * Bewegung — der wärmt seit dem Zusammenlegen aber eine ANDERE Funktion als
   * die, die später wirklich fährt. Ein Anlauf, der nicht denselben Pfad nimmt,
   * ist keiner.
   *
   * Deshalb hier, in derselben Funktion: Es läuft `run` selbst, nur über eine
   * unsichtbare Strecke und ohne Anmeldung. Danach steht das Blatt wieder exakt
   * auf dem Ausgangspunkt.
   */
  const warm = useCallback(() => {
    y.value = park;
    y.value = withTiming(park - 0.002, SHEET_IN, (finished) => {
      "worklet";
      if (finished) y.value = park;
    });
  }, [park, y]);

  /**
   * Eine Fahrt anmelden, die JEMAND ANDERES fährt.
   *
   * Gedacht für die Wisch-Geste: Die muss ihre Ausfahrt im Bild des Loslassens
   * selbst anstoßen, auf dem UI-Strang — der Umweg über den JS-Strang und einen
   * React-Durchgang liegt sonst als spürbares Stocken zwischen Finger und
   * Bewegung. Genau deshalb kann sie nicht `run` benutzen: Das legt ein Bild
   * Vorlauf ein und rechnet die Dauer aus einer Schätzung, die für eine schon
   * halb gezogene Strecke nicht stimmt.
   *
   * Hier bleibt deshalb nur die BUCHHALTUNG: Anmeldung, damit sich nichts in die
   * laufende Bewegung hineincommittet, und der Merker für die Lage — ohne ihn
   * hielte die nächste Umkehr die Strecke für längst zurückgelegt und führe sie
   * in einem Bruchteil der Zeit.
   *
   * @param fromY Wo das Blatt beim Loslassen stand.
   */
  const adopt = useCallback(
    (show: boolean, durationMs: number, fromY: number) => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      clearAdopt();
      // Eine noch laufende Fahrt gilt nicht mehr — ihr Rückruf darf den
      // Schlüssel nicht austragen, den diese Buchung gleich setzt.
      genRef.current += 1;
      gen.value = genRef.current;
      const dur = Math.max(1, Math.round(durationMs));
      markSheetMoving(dur);
      setSheetMoving(true, key);
      motionRef.current = { from: fromY, to: show ? 0 : park, at: Date.now(), dur };
      // Abgemeldet wird über die Dauer: Der Abschluss-Rückruf gehört der fremden
      // Kurve, und die kennt diesen Schlüssel nicht.
      adoptRef.current = setTimeout(() => {
        adoptRef.current = null;
        setSheetMoving(false, key);
      }, dur);
    },
    [clearAdopt, gen, key, park],
  );

  /** Ohne Bewegung an den Ausgangspunkt — für den ersten Aufbau. */
  const parkNow = useCallback(() => {
    clearAdopt();
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    {
      /**
       * Und die Meldung mit zurücknehmen.
       *
       * Sie wird beim Anstoßen sofort gesetzt, zurückgenommen aber erst im
       * Abschluss der Kurve — und die wird hier gerade abgebrochen, bevor sie
       * überhaupt beginnt. Ohne diese Zeile bliebe der Schlüssel für den Rest
       * des App-Laufs in der Menge stehen, und daran hängt die Freigabe der
       * bildschirmfüllenden Texturen. Genau dieser Fall hat schon einmal die
       * Ergebnisliste ruckeln lassen.
       */
      // IMMER, nicht nur wenn das Bild noch aussteht: Läuft die Kurve schon,
      // bricht die Zeile darunter sie ab, ihr Abschluss meldet sich mit
      // `finished === false` und steigt aus — der Schlüssel bliebe hängen.
      setSheetMoving(false, key);
    }
    cancelAnimation(y);
    motionRef.current = { from: park, to: park, at: 0, dur: 1 };
    y.value = park;
  }, [clearAdopt, key, park, y]);

  // Beim Abbau nichts zurücklassen — dieselbe Begründung wie oben.
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (adoptRef.current != null) clearTimeout(adoptRef.current);
      cancelAnimation(y);
      setSheetMoving(false, key);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  return { y, style, run, adopt, parkNow, warm, heal };
}
