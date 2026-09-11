import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  useWindowDimensions,
} from "react-native";
import { X } from "lucide-react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { BinchSwitch } from "@/components/ui/BinchSwitch";
import { SheetModal, SHEET_PAD_H, SHEET_SUBTITLE, SHEET_TITLE } from "@/components/ui/SheetModal";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { haptic } from "@/lib/haptics";
import { useT } from "@/lib/i18n/useT";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { CLOSE_ICON_SIZE, FIELD_H, SPACE } from "@/lib/theme/spacing";
import { primeTick, releaseTick, wheelTick } from "@/lib/ui/tick";
import { ms, scaledStyles } from "@/lib/ui/compact";

/**
 * Preis-Alarm anlegen — das Blatt hinter der Glocke im Ergebnis-Screen.
 *
 * ── WAS HIER VERBOTEN BLEIBT, UND WAS DAS ABZEICHEN STATTDESSEN IST ────────
 *
 * VERBOTEN: die Preis-PROGNOSE. Die Vorlage zu diesem Blatt (Screenshot einer
 * fremden App) sagt „Prices are expected to rise £18 in the next 30 days".
 * So etwas bauen wir nicht, auch nicht abgeschwächt („könnte steigen") — das
 * wäre dieselbe Behauptung mit Ausrede. Wir haben sie nicht und können sie
 * nicht herleiten: Dafür bräuchte es eine Preishistorie je Verbindung über
 * Monate, die dieses Projekt nirgends führt. Sie zu schätzen wäre fatal, denn
 * der Nutzer richtet eine Kaufentscheidung danach aus, und liegt die Zahl
 * daneben, hat ihn die App das Geld gekostet, das sie ihm sparen sollte.
 *
 * DAS ABZEICHEN ÜBER DER ZAHL IST KEINE PROGNOSE. Es speist sich AUSSCHLIESSLICH
 * aus dem Prozentsatz, den der Nutzer gerade selbst eingestellt hat — siehe
 * `tierAt()`. Es liest weder Strecke noch Datum, weder Verkehrsmittel noch
 * Preishöhe, und es fragt nichts ab. Es sagt nur, was für sich genommen wahr
 * ist und keine Daten braucht: Je größer der geforderte Preissturz, desto
 * unwahrscheinlicher, dass er eintritt.
 *
 * Daraus folgt auch die Wortwahl. Die Vorlage schreibt „Unlikely for this route
 * and dates" — DAS DÜRFEN WIR NICHT, weil wir Strecke und Datum gerade nicht
 * auswerten. Unsere Stufen heißen deshalb „Gut möglich" / „Eher
 * unwahrscheinlich" / „Sehr unwahrscheinlich": eine Aussage über die Höhe der
 * Hürde, nicht über diese Verbindung.
 *
 * Wer das später „mit echten Daten verbessern" will: Es gibt keine. Das
 * Abzeichen an eine Herkunft zu hängen, die wir nicht haben, macht aus einer
 * ehrlichen Skala genau die Prognose, die oben verboten ist.
 *
 * Was sonst bleibt, ist überprüfbar: ein Preis, den wir wirklich vorliegen
 * haben, und eine Schwelle, die der Nutzer selbst setzt.
 *
 * ── Aufbau ─────────────────────────────────────────────────────────────────
 *
 * Hülle, Bewegung, Verdunkelung, Zurück-Taste und Wisch-zum-Schließen kommen
 * vollständig aus `SheetModal` — dafür gibt es sie. Der Zuschnitt (Titel,
 * Auswahl, Knopf unten) folgt `TravelOptionsSheets.tsx`, inklusive der Regel,
 * dass erst ÜBERNOMMEN wird, wenn das Blatt unten angekommen ist.
 */

const C = {
  text: "#F4F4F5",
  sub: "#8E8E93",
  /** Freistehende Zeichen tragen in der ganzen App diesen Ton. */
  closeIcon: "#E5E7EB",
  white: "#FFFFFF",
  /**
   * Die mittlere Stufe des Abzeichens — KEIN neuer Ton.
   *
   * Es ist das `amber` aus dem Streckenblatt (`LegTimelineOverlay.tsx`), und
   * dort steht es bereits für genau diese Bedeutung: `stopsAccent` gibt einer
   * direkten Verbindung den Akzent und jeder mit Umstiegen dieses Orange. „Gut"
   * trägt den Akzent, „nicht ideal" trägt Amber — dieselbe Leiter, nur an
   * anderer Stelle.
   */
  amber: "#FFB266",
  /** Das Rot des Projekts — Papierkorb, Herz, Verspätung, Warn-Punkt der
   *  Tab-Leiste. Vierzehn Fundstellen, alle mit derselben Bedeutung. */
  red: "#FF3B5C",
  /**
   * Die gedämpften Hintergründe der Pille — 16 % Deckkraft.
   *
   * Der Wert ist der der Akzent-Palette (`subtle`), nicht frei gewählt: Die
   * grüne Stufe nimmt `accent.subtle` direkt, und die beiden anderen müssen
   * daneben gleich stark gedämpft sein, sonst wirkt eine der drei Pillen
   * kräftiger als die anderen, ohne dass es etwas bedeutet.
   */
  amberSoft: "rgba(255,178,102,0.16)",
  redSoft: "rgba(255,59,92,0.16)",
};

/**
 * Die Spanne des Reglers. 1 bis 50 Prozent in Einer-Schritten.
 *
 * Nach oben gedeckelt, weil darunter nichts Sinnvolles mehr steht: Ein Alarm
 * auf „minus 80 %" löst nie aus und sieht nur so aus, als könnte er es.
 */
const MIN_PCT = 1;
const MAX_PCT = 50;

/** Startwert des Reglers. Eine gängige, unaufdringliche Schwelle. */
const DEFAULT_PCT = 10;

/**
 * Maße des Reglers — SCHON heruntergerechnet, und deshalb weiter unten in einem
 * eigenen, UNskalierten Stilblatt (`sl`).
 *
 * Der Grund ist eine Falle, in die dieser Regler zuerst gelaufen ist: Die
 * Bewegung rechnet mit diesen Zahlen — der Griff läuft von 0 bis
 * `Spurbreite − HANDLE`, und diese Rechnung steht im Worklet, wo keine
 * Skalierung greift. Stünden dieselben Zahlen zusätzlich im `scaledStyles`-
 * Blatt, bekämen sie dort den Faktor: Auf einem kurzen Gerät wäre der Griff 19
 * Punkte breit, während das Worklet weiter mit 24 rechnet. Er käme am rechten
 * Anschlag fünf Punkte zu früh zum Stehen — wenig genug, um es beim Bauen zu
 * übersehen, und genug, um schief auszusehen.
 *
 * Also: einmal hier durch `ms()`, danach nirgends mehr. Dasselbe Vorgehen wie
 * beim Zahlenrad des Uhrzeit-Blattes, das aus demselben Grund ein eigenes
 * `StyleSheet.create` neben dem skalierten führt.
 */
const TRACK_H = ms(4);
const HANDLE = ms(28);
/** Zeile, in der der Regler liegt — auf Fingerbreite, nicht auf Griffbreite. */
const SLIDER_ROW_H = ms(44);

/** Trefferfläche des X — dieselbe Rechnung wie an den anderen freien Zeichen. */
const ICON_HIT_SLOP = (44 - CLOSE_ICON_SIZE) / 2;

/**
 * Die Grenzen der drei Stufen — GESETZT, nicht gemessen.
 *
 * Es gibt nichts zu messen: Wir führen keine Preishistorie (siehe oben). Was
 * die Stufen ausdrücken, ist allein die monotone Aussage „je größer der
 * geforderte Sturz, desto unwahrscheinlicher" — und die braucht keine Daten.
 * Wo genau die Grenze liegt, ist damit eine Setzung, und sie soll auch als
 * solche gelesen werden.
 *
 * Gewählt so, dass die 50 Punkte des Reglers in drei etwa gleich große Bänder
 * fallen (15 / 15 / 20) und der Startwert des Reglers (10 %) im grünen liegt:
 * Wer das Blatt öffnet und nichts anfasst, bekommt keine Warnung für eine
 * Schwelle, die er gar nicht gewählt hat.
 *
 * Wer sie verschieben will, soll das tun — aber bitte als das, was es ist: eine
 * andere Setzung. NICHT als „Kalibrierung", die es nicht gibt.
 */
const TIER_GOOD_MAX = 15;
const TIER_MID_MAX = 30;

/**
 * Der Griff beim Ziehen: schmaler und höher als im Ruhezustand.
 *
 * Aus der Kreisgröße abgeleitet und nicht frei gesetzt, damit beides zusammen
 * bleibt, wenn `HANDLE` sich je ändert. Rund ein Viertel schmaler und ein
 * Drittel höher — genug, dass die Formänderung auffällt, wenig genug, dass es
 * derselbe Griff bleibt und nicht ein anderes Ding.
 *
 * SCHON skaliert, weil `HANDLE` es ist.
 */
const PILL_W = Math.round(HANDLE * 0.72);
const PILL_H = Math.round(HANDLE * 1.3);

/**
 * Wie lange die Formänderung braucht. Beim Anfassen kürzer als beim Loslassen:
 * Die Rückmeldung auf eine Berührung darf nicht warten lassen, das Zurückgehen
 * ist nur noch Ausklang und darf sich Zeit nehmen.
 */
const GRAB_IN = { duration: 160, easing: Easing.out(Easing.cubic) };
const GRAB_OUT = { duration: 220, easing: Easing.out(Easing.cubic) };

/**
 * Währung wie auf den Ergebniskarten: Code in Großbuchstaben hinter der Zahl,
 * die Zahl ohne Nachkommastellen.
 *
 * KEINE eigene Formatierung und kein `Intl`: Die Karten machen es genau so
 * (`ResultCard.tsx`), und derselbe Betrag darf in der Liste nicht anders
 * aussehen als im Blatt darüber. `Intl.NumberFormat` schiede hier ohnehin aus —
 * die Beträge werden vom UI-Strang geschrieben, und dort gibt es kein `Intl`.
 */
function currencyCode(code: string): string {
  return code.toUpperCase();
}

/** Der Prozentwert, auf dem der Regler gerade steht. */
function pctAt(progress: number): number {
  "worklet";
  return Math.round(MIN_PCT + progress * (MAX_PCT - MIN_PCT));
}

/** Anteil des Weges, auf ganze Prozent eingerastet. */
function fracAt(progress: number): number {
  "worklet";
  return (pctAt(progress) - MIN_PCT) / (MAX_PCT - MIN_PCT);
}

function clamp01(v: number): number {
  "worklet";
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Was den Alarm auslösen soll — ganze Einheiten, wie die Karten sie zeigen.
 *
 * MINDESTENS eine Einheit unter dem Grundpreis, und das ist keine Kosmetik:
 * Bei kleinen Beträgen rundet ein Prozent auf null. Aus 10 € wird bei 1 %
 * gerundet wieder 10 € — eine Schwelle, die dem aktuellen Preis entspricht,
 * ist keine Schwelle, sondern eine Meldung über den Ist-Zustand. Der Server
 * weist sie deshalb zurück (`desiredPrice must be below basePrice`), und beim
 * Nutzer kam nur ein „Alarm konnte nicht angelegt werden" an, ohne Grund.
 *
 * Die Untergrenze von 1 fängt den Rest ab: Ein Wunschpreis von 0 oder darunter
 * wäre bei einem Preis von 1 € die Folge und ebenfalls unbrauchbar.
 */
function desiredAt(basePrice: number, pct: number): number {
  "worklet";
  const raw = Math.round(basePrice * (1 - pct / 100));
  return Math.max(1, Math.min(raw, basePrice - 1));
}

/**
 * Der ABZUG — abgeleitet aus dem gerundeten Wunschpreis, nicht getrennt
 * gerechnet.
 *
 * Hier stand `basePrice * pct / 100`, und im Build kam dabei
 * „10% (2.9899999999999984 EUR)" heraus. Zwei Fehler auf einmal:
 *
 *  - Er lief ungerundet in die Anzeige. Fließkommazahlen sind selten glatt,
 *    und 29,99 × 0,1 ist es eben nicht.
 *  - Selbst gerundet hätte er der Karte widersprochen. Die drei Zeilen sind
 *    eine Rechnung, die der Nutzer nachvollzieht: oben der Preis, in der Mitte
 *    der Abzug, unten das Ergebnis. Getrennt gerechnet ergäbe „30 minus 3
 *    macht 27" mit einer 2,99 in der Mitte — die Karte widerspräche sich
 *    selbst.
 *
 * Deshalb ist der Abzug die DIFFERENZ der beiden anderen Zeilen, und beide
 * gehen vom selben gerundeten Grundpreis aus. Damit stimmt die Rechnung
 * zwangsläufig, statt zufällig.
 */
function dropAt(basePrice: number, pct: number): number {
  "worklet";
  return basePrice - desiredAt(basePrice, pct);
}

/** Die Stufe des Abzeichens — allein aus dem eingestellten Prozentsatz.
 *  0 = gut möglich, 1 = eher unwahrscheinlich, 2 = sehr unwahrscheinlich. */
function tierAt(pct: number): number {
  "worklet";
  if (pct <= TIER_GOOD_MAX) return 0;
  if (pct <= TIER_MID_MAX) return 1;
  return 2;
}

/** Die Beschriftungen der drei Stufen, in der Reihenfolge von `tierAt`. */
const TIER_KEYS = [
  "alert.chance.good",
  "alert.chance.unlikely",
  "alert.chance.veryUnlikely",
];

/** Ein Textfeld, dessen Inhalt vom UI-Strang geschrieben werden darf.
 *  Derselbe Weg wie in `TimeSheet.tsx` und `MicBox.tsx`. */
const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

export interface PriceAlertSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Günstigster Preis der aktuell angezeigten Suche. 0 = noch keiner bekannt. */
  currentPrice: number;
  /** ISO-Währungscode aus den Such-Parametern, z.B. "EUR". */
  currency: string;
  fromLabel: string;
  toLabel: string;
  /** Übernehmen. `desiredPrice` in derselben Währung, auf ganze Einheiten gerundet. */
  onCreate: (desiredPrice: number, notifyOnRise: boolean) => void;
}

export const PriceAlertSheet = memo(function PriceAlertSheet({
  visible,
  onClose,
  currentPrice,
  currency,
  fromLabel,
  toLabel,
  onCreate,
}: PriceAlertSheetProps) {
  /**
   * Angelegt wird der Alarm erst, wenn das Blatt UNTEN ist.
   *
   * Dieselbe Regel wie in den Optionen-Blättern des Such-Screens: Der
   * Ergebnis-Screen rendert auf `onCreate` hin neu, und dieser Render fiele
   * sonst genau in die 260ms, in denen das Blatt hinausfährt — ein Commit
   * mitten in der Bewegung, für etwas, das hinter der Verdunkelung niemand
   * sieht. So fallen Abmelden und Anlegen in denselben Durchgang.
   */
  const created = useRef<{ price: number; rise: boolean } | null>(null);
  /**
   * Feste Kennung: An `onClose` hängen in der Hülle die Wisch-Geste und der
   * Merker für die Zurück-Taste. Eine frische Pfeilfunktion würde beide bei
   * jedem Render des Bildschirms darüber neu einrichten — mitten im Blatt.
   */
  const handleClose = useCallback(() => {
    const done = created.current;
    created.current = null;
    onClose();
    if (done) onCreate(done.price, done.rise);
  }, [onClose, onCreate]);

  return (
    <SheetModal visible={visible} onClose={handleClose}>
      {(close) => (
        <PriceAlertBody
          currentPrice={currentPrice}
          currency={currency}
          fromLabel={fromLabel}
          toLabel={toLabel}
          onDismiss={close}
          onSubmit={(price, rise) => {
            created.current = { price, rise };
            close();
          }}
        />
      )}
    </SheetModal>
  );
});

function PriceAlertBody({
  currentPrice,
  currency,
  fromLabel,
  toLabel,
  onDismiss,
  onSubmit,
}: {
  currentPrice: number;
  currency: string;
  fromLabel: string;
  toLabel: string;
  onDismiss: () => void;
  onSubmit: (desiredPrice: number, notifyOnRise: boolean) => void;
}) {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();

  /**
   * EINMAL runden, und dann rechnet alles mit diesem Wert.
   *
   * Der Preis kommt als Fließkommazahl herein (29,99), angezeigt wird er in
   * ganzen Einheiten. Rechnete die Karte weiter mit dem Rohwert, während sie
   * den gerundeten zeigt, ginge ihre eigene Rechnung nicht auf — genau der
   * Fehler, der als „2.9899999999999984" im Build stand. Ein gerundeter
   * Grundwert für Anzeige UND Rechnung schließt das aus, und er geht auch in
   * das, was `onCreate` liefert.
   */
  const basePrice = Math.round(currentPrice);
  /** Zug-Suchen liefern häufig gar keinen Preis — im Projekt dokumentiert.
   *  Das ist kein Randfall, sondern dort der Normalfall. Geprüft wird der
   *  gerundete Wert: Bei 0,40 stünde sonst überall eine 0. */
  const hasPrice = basePrice > 0;
  const code = currencyCode(currency);

  /**
   * Der Schalter hält seinen Zustand SELBST — das Blatt erfährt ihn über eine
   * Referenz.
   *
   * DAS WAR EIN SICHTBARER FEHLER. Vorher stand er hier als React-Zustand, und
   * jedes Umlegen rief einen neuen Durchgang des ganzen Blattes hervor. Zwei
   * seiner Zeilen sind aber `AnimatedTextInput`: Deren Text schreibt der
   * UI-Strang direkt in den Knoten, während React beim Neuzeichnen kurz den
   * `defaultValue` zurücksetzt. Das Ergebnis war genau das gemeldete Aufblitzen
   * der ganzen Karte bei jedem Tipp auf den Schalter.
   *
   * Die Referenz löst es an der Wurzel statt es zu kaschieren: Beim Umlegen
   * rendert nur noch die Schalterzeile, das Blatt gar nicht — und was nicht
   * neu gezeichnet wird, kann auch nicht blitzen. Gelesen wird sie einmal beim
   * Anlegen, dieselbe Bauart wie beim Regler daneben, dessen Wert ebenfalls
   * nicht als Zustand liegt.
   */
  const notifyOnRiseRef = useRef(false);

  /**
   * Der Stand des Reglers als Anteil (0…1) — und zwar AUSSCHLIESSLICH als
   * geteilter Wert, nirgends als Zustand.
   *
   * Das ist die Kernentscheidung dieses Blattes. Ein Regler schreibt beim
   * Ziehen sechzig Werte je Sekunde; läge er in `useState`, wäre das sechzig
   * React-Durchgänge über das ganze Blatt, jeder mit Schaltern, Karte und Knopf
   * darin — auf dem JS-Strang, während die Geste auf dem UI-Strang läuft. Genau
   * dieses Muster ist im Projekt mehrfach als Ursache von Rucklern vermerkt.
   *
   * Stattdessen: Die Zahlen, die sich beim Ziehen ändern, sind Textfelder, die
   * der UI-Strang direkt beschreibt (`useAnimatedProps`), und der Endwert wird
   * beim Antippen des Knopfes EINMAL aus dem geteilten Wert gelesen. Zwischen
   * Aufsetzen und Loslassen läuft damit kein einziger React-Durchgang.
   */
  const progress = useSharedValue((DEFAULT_PCT - MIN_PCT) / (MAX_PCT - MIN_PCT));

  /**
   * Die Breite der Spur wird GEMESSEN, nicht gerechnet.
   *
   * Anders als beim Fortschrittsbalken der Ergebnisliste, der sich seine Breite
   * aus der Fensterbreite ableitet: Dort gehören die Ränder derselben Datei.
   * Hier sitzt der Regler in einem Blatt, dessen seitlicher Innenabstand
   * `SheetModal` gehört — nachgerechnet würde diese Datei eine fremde Zahl
   * mitführen und beim nächsten Feinschliff dort still falsch werden.
   *
   * Das erste Bild mit Breite 0 tut nichts zur Sache: Beim Aufbau läuft keine
   * Bewegung, der Regler steht still, und die Geste prüft ohnehin auf 0.
   *
   * Als GETEILTER Wert und nicht als Zustand — sonst wäre die Vermessung ein
   * zusätzlicher Render, und die Geste müsste bei jeder Änderung neu gebaut
   * werden.
   */
  const { width: winW } = useWindowDimensions();
  /**
   * VORAUSGERECHNET, nicht bei Null angefangen — das war ein sichtbarer Fehler.
   *
   * Die Füllung ist `width: "100%"` und bekommt ihre Breite vom Layout, also
   * sofort richtig. Ihre Verschiebung dagegen kommt aus dieser Zahl, und die
   * traf erst mit `onLayout` ein — bei einem `Modal` unter Android heißt das
   * ein eigenes Fenster und dessen erstes Layout, das spürbar später kommt. In
   * der Lücke stand die Spur voll eingefärbt, während der Griff links klebte;
   * danach sprang er von selbst an seinen Platz. Genau das war zu sehen.
   *
   * Die Spur ist so breit wie der Blattinhalt, und der ist die Fensterbreite
   * minus zweimal dessen seitlichem Abstand. Beides ist VOR dem ersten Bild
   * bekannt. `onLayout` bleibt trotzdem stehen und behält das letzte Wort —
   * bei einer Drehung oder einem anderen Fensterzuschnitt korrigiert es die
   * Schätzung, statt dass sie stehen bleibt.
   */
  const trackW = useSharedValue(Math.max(0, winW - SHEET_PAD_H * 2));

  /**
   * Liegt ein Finger auf dem Regler? 0 = nein, 1 = ja — dazwischen die weiche
   * Überblendung der Form.
   *
   * Als GETEILTER Wert und ausdrücklich NICHT als Zustand: Anfassen und
   * Loslassen wären sonst zwei React-Durchgänge über das ganze Blatt, bei jeder
   * Berührung des Reglers. Gesetzt wird er in `onBegin`/`onFinalize` der Geste
   * — also auch dann sauber zurückgenommen, wenn die Geste gar nicht anspringt,
   * weil der Zug senkrecht war und das Blatt ihn bekommt.
   */
  const grab = useSharedValue(0);

  /** Klang und Stups liegen bereit, sobald das Blatt steht — nicht im
   *  Durchgang, der es öffnet (siehe `lib/ui/tick.ts`). */
  useEffect(() => {
    primeTick();
    return releaseTick;
  }, []);

  /**
   * Ein Prozent weiter — Klick und Stups, wie am Zahlenrad des Uhrzeit-Blattes.
   *
   * Der Vergleich läuft im Bild-Takt auf dem UI-Strang und ist nicht mehr als
   * eine Rundung; gemeldet wird nur der Wechsel. Die Rückmeldung selbst liegt
   * auf dem JS-Strang und kann die Bewegung deshalb nicht bremsen. `wheelTick`
   * drosselt sich selbst — beim schnellen Durchziehen über fünfzig Werte ist
   * das nötig.
   */
  useAnimatedReaction(
    () => pctAt(progress.value),
    (cur, prev) => {
      if (prev === null || cur === prev) return;
      runOnJS(wheelTick)();
    },
  );

  /**
   * Die Stufe des Abzeichens ist das EINZIGE am Regler, das durch React läuft
   * — und das ist kein Rückfall, sondern die richtige Grenze.
   *
   * Der Unterschied zur Prozentzahl: Die ändert sich bei jeder Fingerbewegung,
   * die Stufe höchstens zweimal über den ganzen Weg. Beobachtet wird deshalb
   * `tierAt` und nicht `pctAt` — die Reaktion feuert nur beim echten Wechsel,
   * nicht bei jedem Prozent.
   *
   * Warum überhaupt React: Die Pille passt sich ihrer Beschriftung an, und die
   * ist in vier Sprachen verschieden lang. Ein Textfeld, das der UI-Strang
   * beschreibt, wächst nicht mit seinem Inhalt — es müsste eine feste Breite
   * bekommen, die für „Sehr unwahrscheinlich" und „Muy improbable"
   * gleichermaßen passt. Das wäre eine Pille mit Luft an den Seiten, deren
   * Menge von der Sprache abhängt.
   */
  const [tier, setTier] = useState(tierAt(DEFAULT_PCT));
  useAnimatedReaction(
    () => tierAt(pctAt(progress.value)),
    (cur, prev) => {
      if (prev === null || cur === prev) return;
      runOnJS(setTier)(cur);
    },
  );

  /**
   * EIN Gesten-Objekt für die Lebensdauer des Blattes.
   *
   * Deshalb liegt die Spurbreite in einem geteilten Wert: Käme sie aus einem
   * Zustand, müsste diese Geste bei der Vermessung neu gebaut werden, und der
   * Erkenner müsste sie gegen seinen nativen Knoten neu abgleichen — im
   * Projekt mehrfach als Quelle verlorener Gesten vermerkt.
   *
   * `activeOffsetX` / `failOffsetY` sind hier keine Feinheit, sondern
   * Bedingung: Über dem ganzen Blatt liegt die Wisch-zum-Schließen-Geste von
   * `SheetModal`. Ohne die beiden Riegel entschiede die Reihenfolge im Baum,
   * wer einen Zug bekommt — ein waagerechtes Ziehen am Regler könnte das Blatt
   * schließen, ein senkrechtes den Wert verstellen. So nimmt der Regler nur
   * Waagerechtes und gibt Senkrechtes ausdrücklich ab.
   */
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-8, 8])
        .failOffsetY([-12, 12])
        /**
         * Die Form ändert sich schon beim AUFSETZEN, nicht erst beim
         * Anspringen der Geste: Sie ist die Rückmeldung „der Regler hat dich",
         * und die muss vor der ersten Bewegung da sein.
         *
         * `onFinalize` statt `onEnd`, weil es IMMER läuft — auch wenn die
         * Geste nie anspringt, etwa weil der Zug senkrecht war und das Blatt
         * ihn übernimmt. Mit `onEnd` bliebe der Griff in solchen Fällen als
         * Pille stehen.
         */
        .onBegin(() => {
          grab.value = withTiming(1, GRAB_IN);
        })
        .onFinalize(() => {
          grab.value = withTiming(0, GRAB_OUT);
        })
        /**
         * Beim Anspringen auf den Finger springen: Der Griff setzt sich unter
         * die Berührung, statt sich relativ von seinem alten Platz zu bewegen.
         * Das ist das Verhalten, das man von einem Regler erwartet — sowohl
         * beim Greifen des Griffes (er liegt dann ohnehin schon dort) als auch
         * beim Fassen der Spur.
         *
         * Gerechnet wird auf die MITTE des Griffes, deshalb das halbe
         * Griffmaß: Der Wert sitzt in seiner Mitte, nicht an seiner Kante.
         */
        .onStart((e) => {
          const w = trackW.value;
          if (w <= HANDLE) return;
          progress.value = clamp01((e.x - HANDLE / 2) / (w - HANDLE));
        })
        /**
         * `onChange`, nicht `onUpdate`: Der Zuwachs seit dem letzten Bild
         * braucht keinen Startwert, und weil die Geste erst nach acht Punkten
         * anspringt, spränge der Wert mit der Gesamtverschiebung um genau
         * diese acht.
         */
        .onChange((e) => {
          const w = trackW.value;
          if (w <= HANDLE) return;
          progress.value = clamp01(progress.value + e.changeX / (w - HANDLE));
        }),
    [progress, trackW, grab],
  );

  /**
   * Der gefüllte Teil wird VERSCHOBEN, nicht in der Breite animiert.
   *
   * Er ist so breit wie die ganze Spur und liegt um den fehlenden Rest nach
   * links versetzt; die Spur schneidet ihn ab (`overflow: "hidden"`). Eine
   * animierte Breite wäre eine Maßänderung und damit ein Layout-Durchgang pro
   * Bild — dieselbe Regel, aus der auch der Verlauf im Fortschrittsbalken der
   * Ergebnisliste als starres Kind unter einer bewegten Hülle liegt.
   *
   * Die Kante endet in der MITTE des Griffes, nicht an seinem Rand: Dort sitzt
   * der Wert, und nur so laufen Farbe und Griff nicht sichtbar auseinander.
   */
  const fillStyle = useAnimatedStyle(() => {
    const w = trackW.value;
    const edge = fracAt(progress.value) * (w - HANDLE) + HANDLE / 2;
    return { transform: [{ translateX: edge - w }] };
  });

  /**
   * Der Griff: Kreis im Ruhezustand, stehende Pille unter dem Finger.
   *
   * Animiert werden BREITE, HÖHE und RADIUS — nicht `scaleX`/`scaleY`, obwohl
   * eine Verschiebung billiger wäre als ein Layout. Ungleichmäßiges Skalieren
   * verzerrt aber genau das, was hier die Form ausmacht: Aus den runden Enden
   * würden Ellipsen, und der 2 Punkte starke Rand wäre auf der einen Achse
   * dünner als auf der anderen. Eine Pille mit ovalen Kappen und ungleichem
   * Rand ist keine Pille.
   *
   * Der Layout-Durchgang, den das kostet, bleibt auf diesen einen Knoten
   * beschränkt: Der Griff liegt ABSOLUT in der Reglerzeile, ist damit aus dem
   * Fluss genommen und hat keine Kinder. Es gibt also niemanden, dessen Platz
   * sich mit ihm ändert — die Spur daneben ist ein gewöhnliches Kind und merkt
   * davon nichts.
   *
   * Senkrecht bleibt er von selbst mittig: Die Zeile richtet ihre Kinder
   * zentriert aus, und ein absolut gesetzter Knoten ohne `top`/`bottom` folgt
   * dieser Ausrichtung. Deshalb braucht die wachsende Höhe keine Gegenrechnung.
   *
   * Waagerecht wird die MITTE geführt, nicht die linke Kante. Sonst rutschte
   * der Griff beim Anfassen um die halbe Breitendifferenz zur Seite — er
   * verlöre also genau in dem Moment den Wert, in dem man ihn greift. Und die
   * Kante der Füllung endet an derselben Mitte, damit beide zusammenbleiben.
   */
  const handleStyle = useAnimatedStyle(() => {
    const wide = HANDLE + (PILL_W - HANDLE) * grab.value;
    const high = HANDLE + (PILL_H - HANDLE) * grab.value;
    const center = HANDLE / 2 + fracAt(progress.value) * (trackW.value - HANDLE);
    return {
      width: wide,
      height: high,
      borderRadius: wide / 2,
      transform: [{ translateX: center - wide / 2 }],
    };
  });

  /**
   * Die Zahlen schreibt der UI-Strang selbst.
   *
   * Sie rasten auf ganze Prozent ein wie der Griff — stünde über einem Griff,
   * der auf 12 steht, eine 11,6, wäre das kein Rundungsfehler, sondern zwei
   * Anzeigen desselben Wertes, die sich widersprechen.
   */
  const pctProps = useAnimatedProps<TextInputProps & { text: string }>(() => {
    "worklet";
    // Nur die Ziffern — das Prozentzeichen steht als eigener, ruhender Text
    // daneben (siehe unten im Baum).
    return { text: `${pctAt(progress.value)}` };
  });

  const dropProps = useAnimatedProps<TextInputProps & { text: string }>(() => {
    "worklet";
    const pct = pctAt(progress.value);
    return { text: `${pct}% (${dropAt(basePrice, pct)} ${code})` };
  });

  const desiredProps = useAnimatedProps<TextInputProps & { text: string }>(() => {
    "worklet";
    return { text: `${desiredAt(basePrice, pctAt(progress.value))} ${code}` };
  });

  /**
   * Der Ton der Pille. Grün ist der AKZENT, nicht ein eigenes Grün.
   *
   * Das Streckenblatt macht es genauso (`stopsAccent`): direkte Verbindung →
   * Akzent, mit Umstiegen → Amber. Ein zweites Grün daneben wären zwei Grüns in
   * einem Blatt, die nichts voneinander wissen. Beide Akzente der App (Lime und
   * Mint) lesen sich als „gut" — Mint ist ein Blaugrün, aber unverkennbar auf
   * der grünen Seite.
   *
   * Fläche gedämpft, Schrift in der Vollfarbe: dasselbe Verhältnis wie in der
   * Vorlage und wie überall sonst in der App, wo eine Pille eine Eigenschaft
   * trägt.
   */
  const tone =
    tier === 0
      ? { fg: accent.solid, bg: accent.subtle }
      : tier === 1
        ? { fg: C.amber, bg: C.amberSoft }
        : { fg: C.red, bg: C.redSoft };

  const submit = () => {
    if (!hasPrice) return;
    haptic("button");
    // EINMAL aus dem geteilten Wert gelesen — er ist auf dem JS-Strang
    // jederzeit abrufbar, und genau deshalb braucht der Regler keinen Zustand.
    onSubmit(desiredAt(basePrice, pctAt(progress.value)), notifyOnRiseRef.current);
  };

  return (
    <>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title}>{t("alert.title")}</Text>
          {/* Die Strecke steht als Unterzeile — das Blatt gehört zu EINER Suche,
              und ohne sie wüsste man nach dem Öffnen nicht mehr, zu welcher. */}
          <Text style={styles.subtitle} numberOfLines={1}>
            {`${fromLabel} – ${toLabel}`}
          </Text>
        </View>
        {/* Das X ist streng genommen doppelt — die Hülle bringt Wischen, die
            Verdunkelung und die Zurück-Taste schon mit. Es bleibt trotzdem: Von
            diesen dreien ist keiner sichtbar, und ein Blatt, das eine Eingabe
            verlangt, braucht einen Ausgang, den man SIEHT. */}
        <RippleTouch
          borderless
          hitSlop={ICON_HIT_SLOP}
          onPress={onDismiss}
          accessibilityLabel={t("common.close")}
          style={styles.closeBtn}
        >
          <X size={CLOSE_ICON_SIZE} color={C.closeIcon} strokeWidth={2} />
        </RippleTouch>
      </View>

      {/**
        * Das Abzeichen — und was es NICHT ist, steht oben in der Datei.
        *
        * Es hängt allein an `tier`, und `tier` allein am eingestellten
        * Prozentsatz. Kein Netzaufruf, keine Strecke, kein Datum.
        */}
      <View style={[styles.badge, { backgroundColor: tone.bg }]}>
        <Text style={[styles.badgeText, { color: tone.fg }]} numberOfLines={1}>
          {t(TIER_KEYS[tier] ?? TIER_KEYS[0])}
        </Text>
      </View>

      {/**
        * Die große Zahl ist ZWEIGETEILT: die Ziffern kräftig, das Prozentzeichen
        * schwächer und kleiner. Zwei Töne, ein Element.
        *
        * Dass daraus zwei Knoten werden, ist keine Stilfrage, sondern folgt aus
        * dem Weg: Der Wert wird vom UI-Strang geschrieben, und `animatedProps`
        * setzt den GANZEN Inhalt eines Feldes. Ein Feld mit zwei verschieden
        * gesetzten Teilen gibt es damit nicht. Also lebt nur das linke Feld, das
        * Zeichen daneben ist ein gewöhnlicher Text und ändert sich nie.
        *
        * Die feste Mindestbreite der Ziffern ist der Grund, warum nichts
        * wandert: Zwei Stellen sind reserviert, ob sie belegt sind oder nicht,
        * und die Ziffern stehen rechtsbündig darin. Dieselbe Vorkehrung wie am
        * Zähler der Reisenden — dort steht sie mit derselben Begründung.
        *
        * ZENTRIERT wiegt das schwerer als vorher, nicht leichter. Links
        * ausgerichtet hätte ein fehlendes Reservat nur das Prozentzeichen
        * verschoben; mittig ausgerichtet verschiebt es die GANZE Gruppe, und
        * zwar bei jedem Wechsel zwischen 9 und 10 — mitten im Ziehen, also
        * genau dann, wenn man hinsieht. Mit dem Reservat ist die Breite der
        * Gruppe konstant, sie bleibt also stehen.
        *
        * Der Preis dafür, ehrlich benannt: Bei einstelligen Werten steht in der
        * reservierten Fläche links eine leere Ziffernbreite, die Gruppe wirkt
        * dadurch um eine halbe Ziffer nach rechts versetzt. Das ist die
        * günstigere Hälfte des Tauschs — die Alternative wäre, die Gruppe bei
        * jedem Überschreiten der 9 springen zu lassen, und ein Sprung fällt
        * ungleich mehr auf als ein Versatz, den man ohne Vergleich gar nicht
        * bemerkt. Ganz zu haben ist beides nicht: Ein Text veränderlicher
        * Breite kann entweder feste Kanten haben oder eine feste Mitte.
        *
        * Reserviert ist bewusst großzügig: Bleibt Platz übrig, sieht man ihn
        * kaum; reicht er nicht, wächst das Feld und die Gruppe wandert doch —
        * also genau der Fehler, den das Reservat verhindern soll.
        */}
      <View style={styles.pctRow}>
        <AnimatedTextInput
          editable={false}
          pointerEvents="none"
          underlineColorAndroid="transparent"
          defaultValue={`${DEFAULT_PCT}`}
          animatedProps={pctProps}
          style={styles.pctNum}
        />
        <Text style={styles.pctSign}>%</Text>
      </View>

      <GestureDetector gesture={pan}>
        <View
          style={sl.sliderRow}
          onLayout={(e) => {
            trackW.value = e.nativeEvent.layout.width;
          }}
        >
          <View style={[sl.track, { backgroundColor: palette.s3 }]}>
            <Animated.View
              style={[sl.fill, { backgroundColor: accent.solid }, fillStyle]}
            />
          </View>
          {/* Helle Füllung, Rand in der Farbe des Blattes — siehe `sl.handle`.
              Der Akzent bleibt dem zurückgelegten Teil der Spur vorbehalten. */}
          <Animated.View
            style={[
              sl.handle,
              { backgroundColor: C.white, borderColor: palette.s1 },
              handleStyle,
            ]}
          />
        </View>
      </GestureDetector>

      {hasPrice ? (
        <View style={[styles.card, { backgroundColor: palette.s2 }]}>
          <View style={styles.cardRow}>
            <Text style={styles.cardLabel}>{t("alert.current")}</Text>
            <Text style={styles.cardValue}>{`${basePrice} ${code}`}</Text>
          </View>

          {/**
            * Die EINZIGE Trennlinie der Karte, und sie steht mit Absicht genau
            * hier: Über ihr steht, was IST — ein Preis, den wir vorliegen haben.
            * Darunter steht, was der Nutzer daraus MACHT. Zwischen diesen beiden
            * Sorten von Zeile verläuft die einzige Grenze, die es in dieser
            * Karte zu ziehen gibt; eine Linie zwischen je zwei Zeilen wäre eine
            * Tabelle und würde nichts mehr aussagen.
            */}
          <View style={[sl.divider, { backgroundColor: palette.border }]} />

          <View style={styles.cardRow}>
            <Text style={styles.cardLabel}>{t("alert.drop")}</Text>
            <AnimatedTextInput
              editable={false}
              pointerEvents="none"
              underlineColorAndroid="transparent"
              defaultValue={`${DEFAULT_PCT}% (${dropAt(basePrice, DEFAULT_PCT)} ${code})`}
              animatedProps={dropProps}
              style={styles.cardValueLive}
            />
          </View>
          <View style={styles.cardRow}>
            <Text style={styles.cardLabel}>{t("alert.desired")}</Text>
            <AnimatedTextInput
              editable={false}
              pointerEvents="none"
              underlineColorAndroid="transparent"
              defaultValue={`${desiredAt(basePrice, DEFAULT_PCT)} ${code}`}
              animatedProps={desiredProps}
              style={[styles.cardValueLive, { color: accent.solid }]}
            />
          </View>

          {/* Die Schalterzeile hält ihren Zustand selbst — die Begründung
              steht bei `RiseRow` weiter unten, sie ist der Grund, warum die
              Karte beim Umlegen nicht mehr aufblitzt. */}
          <RiseRow label={t("alert.rise")} onChange={(v) => (notifyOnRiseRef.current = v)} />
        </View>
      ) : (
        /* Ohne Preis wird hier NICHTS gerechnet und nichts gezeigt, was nach
           einer Zahl aussieht. Der Regler bleibt stehen — er ist das Bedienteil
           des Blattes, und ohne ihn fiele der Inhalt in sich zusammen —, aber
           anlegen lässt sich nichts, wovon der Auslöser unbekannt ist. */
        <Text style={styles.noPrice}>{t("alert.noprice")}</Text>
      )}

      <RippleTouch
        disabled={!hasPrice}
        onPress={submit}
        rippleColor="rgba(0,0,0,0.32)"
        style={[styles.cta, { backgroundColor: accent.solid }, !hasPrice && styles.ctaOff]}
      >
        <Text style={[styles.ctaText, { color: accent.textOnSolid }]}>
          {t("alert.create")}
        </Text>
      </RippleTouch>
    </>
  );
}

/**
 * Die Schalterzeile — ein EIGENES Bauteil, und zwar aus einem Grund.
 *
 * Sie hält ihren Zustand selbst und meldet ihn nur nach oben. Damit rendert
 * beim Umlegen ausschließlich diese Zeile, nicht das ganze Blatt. Läge der
 * Zustand oben, zeichnete jeder Tipp die Karte darüber neu — und deren
 * Werte-Zeilen sind `AnimatedTextInput`, die dabei kurz auf ihren
 * `defaultValue` zurückfallen. Genau das war als Aufblitzen der ganzen Karte
 * zu sehen.
 *
 * AUSRICHTUNG: Dieselbe `cardRow` wie die drei Zeilen darüber, und der Text
 * trägt wie sie `flex: 1`. Damit steht er auf derselben Fluchtlinie wie
 * „Aktueller Preis" und der Schalter dort, wo die Werte stehen.
 *
 * Der Schalter ist ABSICHTLICH nicht selbst bedienbar: Die ganze Zeile ist die
 * Trefferfläche. Lägen beide Ziele übereinander, schaltete ein Tipp auf den
 * Schalter zweimal.
 *
 * `Pressable` und nicht `RippleTouch`: Die Zeile muss sich der Sprachausgabe
 * als Schalter melden, und dafür braucht sie `accessibilityRole` samt
 * `accessibilityState` — beides reicht `RippleTouch` nicht durch.
 */
const RiseRow = memo(function RiseRow({
  label,
  onChange,
}: {
  label: string;
  onChange: (v: boolean) => void;
}) {
  const [on, setOn] = useState(false);
  return (
    <Pressable
      onPress={() => {
        haptic("button");
        setOn((v) => {
          const next = !v;
          onChange(next);
          return next;
        });
      }}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      style={styles.cardRow}
    >
      <Text style={styles.riseLabel}>{label}</Text>
      <BinchSwitch value={on} readOnly />
    </Pressable>
  );
});

const styles = scaledStyles({
  head: { flexDirection: "row", alignItems: "flex-start", gap: SPACE.md },
  headText: { flex: 1, minWidth: 0 },
  closeBtn: { alignItems: "center", justifyContent: "center" },
  title: { ...SHEET_TITLE, marginBottom: SPACE.sm },
  subtitle: { ...SHEET_SUBTITLE },

  /**
   * Ziffern und Zeichen sitzen auf EINER Grundlinie.
   *
   * `alignItems: "baseline"` und nicht `"flex-end"`: Die beiden sind
   * verschieden groß, ihre Unterkanten liegen also nicht dort, wo ihre
   * Grundlinien liegen. An der Unterkante ausgerichtet hinge das kleinere
   * Zeichen sichtbar zu tief. Damit die Grundlinie auf Android überhaupt
   * verlässlich ist, tragen BEIDE Knoten `includeFontPadding: false` — sonst
   * rechnet Android bei ihnen unterschiedlich viel Luft mit ein.
   */
  /**
   * Die Pille sitzt über der Zahl und mittig — `alignSelf`, weil das Blatt
   * seine Kinder sonst über die volle Breite zieht.
   */
  badge: {
    alignSelf: "center",
    borderRadius: 9999,
    paddingVertical: 5,
    paddingHorizontal: SPACE.md,
    marginTop: SPACE.xl,
  },
  /** 12/700 — die Stufe der „Ändern"-Pille im Ergebnis-Screen, also die, die
   *  die App für kurze Beschriftungen auf einer Fläche führt. */
  badgeText: { fontSize: 12, fontWeight: "700", letterSpacing: 0.2 },

  pctRow: {
    flexDirection: "row",
    alignItems: "baseline",
    // Mittig — wie in der Vorlage. Möglich nur, weil die Ziffern eine feste
    // Breite reservieren; ohne die wanderte die ganze Gruppe (siehe Baum).
    justifyContent: "center",
    marginTop: SPACE.sm,
  },

  /**
   * Die Ziffern — Maße von der Uhrzeit im Zeit-Blatt (`headTime`), nicht neu
   * erfunden.
   *
   * Es ist dieselbe Sache: die eine lebende Zahl im Kopf eines Blattes, vom
   * UI-Strang in ein Textfeld geschrieben. Zwei davon dürfen nicht verschieden
   * aussehen. `tabular-nums` ist dabei nicht Kosmetik, sondern der Grund, warum
   * hier nicht die Bildschirm-Überschrift steht: Ohne gleich breite Ziffern
   * wandert die Zahl beim Ziehen seitlich, weil eine 1 schmaler ist als eine 8.
   * `includeFontPadding` und die genullten Abstände nehmen dem Textfeld die
   * Android-Polsterung, mit der es tiefer säße als ein Text.
   *
   * Die Farbe ist die starke Textfarbe, NICHT der Akzent. Sie war es vorher,
   * und die Vorlage hält es anders: Dort trägt der Akzent den zurückgelegten
   * Teil des Reglers, die Zahl steht in der Textfarbe. Das ist auch die
   * ruhigere Aufteilung — der Akzent zeigt dann an EINER Stelle, wo man steht,
   * statt an zweien dasselbe zu sagen.
   *
   * `minWidth`: Platz für zwei Stellen, mehr kann der Regler nicht liefern
   * (Deckel bei 50). Zur Herleitung siehe den Kommentar im Baum.
   */
  pctNum: {
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.8,
    color: C.text,
    minWidth: 40,
    textAlign: "right",
    padding: 0,
    margin: 0,
    includeFontPadding: false,
    fontVariant: ["tabular-nums"],
  },

  /**
   * Das Prozentzeichen — schwächer und kleiner als die Ziffern.
   *
   * 22/800 ist keine neue Stufe: Es ist die Größe der Stationsnamen im
   * Ergebnis-Screen, also die nächstkleinere kräftige Stufe, die der Bestand
   * ohnehin führt. Die gedämpfte Textfarbe macht den Rest — zusammen liest sich
   * das als eine Angabe mit einer Einheit, nicht als zwei Angaben.
   */
  pctSign: {
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.44,
    color: C.sub,
    marginLeft: SPACE.xs,
    includeFontPadding: false,
  },

  card: { borderRadius: 16, padding: SPACE.lg, gap: SPACE.md },
  cardRow: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
  cardLabel: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: "600", color: C.sub },
  cardValue: { fontSize: 15, fontWeight: "700", color: C.text },
  /** Wie `cardValue`, nur als Textfeld — deshalb ohne Polsterung und mit
   *  gleich breiten Ziffern, damit die Zeile beim Ziehen nicht zappelt. */
  cardValueLive: {
    fontSize: 15,
    fontWeight: "700",
    color: C.text,
    textAlign: "right",
    padding: 0,
    margin: 0,
    includeFontPadding: false,
    fontVariant: ["tabular-nums"],
  },

  riseLabel: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: "600", color: C.text },

  noPrice: { ...SHEET_SUBTITLE },

  /** Wie der Such-Knopf im Such-Screen: volle Breite, Feldhöhe, 16er Radius. */
  cta: {
    height: FIELD_H,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginTop: SPACE.lg,
  },
  /** Ohne bekannten Preis gesperrt — sichtbar, aber erkennbar aus dem Spiel.
   *  Derselbe Wert wie am „Zurücksetzen" der Optionen-Blätter. */
  ctaOff: { opacity: 0.4 },
  ctaText: { fontSize: 17, fontWeight: "700" },
});

/**
 * Was NICHT durch die Skalierung laufen darf — und darum in einem eigenen,
 * rohen Stilblatt steht.
 *
 * Zwei Gründe, beide handfest:
 *
 *  - Die Maße des Reglers hängen an `TRACK_H`, `HANDLE` und `SLIDER_ROW_H`, und
 *    die sind oben schon durch `ms()` gegangen, weil die BEWEGUNG mit ihnen
 *    rechnet. Ein zweites Mal gedreht liefen Bewegung und Darstellung
 *    auseinander (siehe dort).
 *  - Die Trennlinie ist eine Haarlinie. `Math.round(0,5 × 0,8)` ist NULL — im
 *    skalierten Blatt verschwände sie auf kurzen Geräten spurlos, und zwar
 *    genau dort, wo Platz knapp ist und Gliederung am meisten hilft.
 *    `StyleSheet.hairlineWidth` trifft die Gerätedichte ohnehin genauer als
 *    jede feste Zahl.
 *
 * Die Außenabstände hier stammen aus demselben Raster wie überall, sie werden
 * nur von Hand gedreht, weil sie in diesem Blatt mitkommen müssen.
 */
const sl = StyleSheet.create({
  divider: { height: StyleSheet.hairlineWidth },

  sliderRow: {
    height: SLIDER_ROW_H,
    justifyContent: "center",
    marginTop: ms(SPACE.xs),
    marginBottom: ms(SPACE.lg),
  },
  track: {
    height: TRACK_H,
    borderRadius: TRACK_H / 2,
    // Schneidet den verschobenen Füllteil an beiden Enden ab.
    overflow: "hidden",
  },
  fill: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    // Prozentwert, bewusst relativ: Die Spur misst sich selbst, ihr Füllteil
    // ist immer genau so breit wie sie.
    width: "100%",
  },
  handle: {
    position: "absolute",
    left: 0,
    width: HANDLE,
    height: HANDLE,
    borderRadius: HANDLE / 2,
    /**
     * Der Rand — und er ist nicht der der Vorlage.
     *
     * Dort steht ein weißer Griff auf HELLEM Grund und braucht eine feine
     * graue Linie, um sich überhaupt abzuheben. Bei uns liegt er auf dem
     * dunklen Blatt; dieselbe Linie wäre schlicht unsichtbar, also Zierde, die
     * nichts zeichnet.
     *
     * Gebraucht wird sie trotzdem, nur gegen etwas anderes: Der Griff sitzt
     * links auf der Akzentfläche des zurückgelegten Teils. Ein Rand in der
     * FARBE DES BLATTES stanzt ihn dort heraus, statt ihn an ihr kleben zu
     * lassen — dieselbe „ausgestanzt"-Optik, die der Tausch-Knopf des alten
     * Ergebnis-Kopfes und der Punkt der Glocke benutzen. Die Farbe kommt
     * deshalb von außen, sie hängt am Theme.
     */
    borderWidth: 2,
  },
});
