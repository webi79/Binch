import { memo } from "react";
import { Pressable, View, Text, type ViewStyle } from "react-native";
import { format, parseISO } from "date-fns";
import {
  de as deLocale,
  enUS,
  fr as frLocale,
  es as esLocale,
  type Locale as DateLocale,
} from "date-fns/locale";
import {
  ArrowLeft,
  Bell,
  Bus,
  Plane,
  PlaneTakeoff,
  Ship,
  Train,
  type LucideIcon,
} from "lucide-react-native";

import { RippleTouch } from "@/components/ui/RippleTouch";
import { useT } from "@/lib/i18n/useT";
import { usePalette } from "@/lib/theme/appBg";
import { CLOSE_ICON_SIZE, FIELD_H, GUTTER, SPACE } from "@/lib/theme/spacing";
import { ms, scaledStyles } from "@/lib/ui/compact";
import { useSearchStore } from "@/stores/searchStore";
import type { TravelMode } from "@/types/search";

const C = {
  text: "#F4F4F5",
  sub: "#8E8E93",
  /** Freistehende Zeichen (X in Ortswähler, Bo und Spracheingabe) tragen in der
   *  ganzen App diesen Ton — der Pfeil hier ist keines davon ausgenommen. */
  closeIcon: "#E5E7EB",
};

/**
 * Das Feld, in dem ein freistehendes Zeichen sitzt — links wie rechts dasselbe.
 *
 * Es trägt keine Farbe und keinen Radius, es hält nur Platz. Genau darin liegt
 * sein Zweck: Pfeil und Glocke sind unterschiedlich große Zeichen (26 gegen
 * 19), und ohne ein gemeinsames Feld wäre die Zeile links 7 Punkte breiter als
 * rechts. Die Herleitung steht am `gap` des Stilblatts.
 *
 * BEWUSST NICHT im `scaledStyles`-Blatt.
 *
 * Das wäre der naheliegende Ort und die falsche Wahl: Die Größe der Zeichen
 * selbst steht als `size`-Eigenschaft im JSX, und die läuft durch keine
 * Skalierung — im ganzen Projekt nicht, `Bell size={19}` im Landingscreen so
 * gut wie `Icon size={20}` unten in der Box. Ein mitschrumpfendes Feld würde
 * auf einem kurzen Gerät also 21 Punkte breit, während das Zeichen darin seine
 * 26 behält: Der Pfeil ragte über sein eigenes Feld hinaus und die Symmetrie,
 * für die es da ist, wäre dahin.
 */
const ICON_BOX: ViewStyle = {
  width: CLOSE_ICON_SIZE,
  height: CLOSE_ICON_SIZE,
  alignItems: "center",
  justifyContent: "center",
};

/**
 * Was aus dem 26er-Feld eine 44er-Trefferfläche macht — für BEIDE Zeichen.
 *
 * Dieselbe Rechnung wie `CLOSE_PAD` in `ChatDrawer.tsx` und in Bos Kopfzeile,
 * aber als `hitSlop` statt als Innenabstand mit aufhebendem negativem
 * Außenabstand. Der Grund ist die Zeile: Sie ordnet ihre drei Elemente über
 * `gap`, und ein negativer Außenabstand würde von genau diesem Abstand wieder
 * abgezogen — das Zeichen rückte 9 Punkte an die Box heran, obwohl es im Layout
 * gar nicht breiter geworden ist. `hitSlop` fasst das Layout nicht an.
 */
const ICON_HIT_SLOP = (44 - CLOSE_ICON_SIZE) / 2;

/**
 * Größe des Glocken-Zeichens — 19 wie im Landingscreen, NICHT 26 wie der Pfeil.
 *
 * Zwei freie Zeichen nebeneinander sollen gleich groß WIRKEN, und dafür ist die
 * Kantenlänge das falsche Maß: Entscheidend ist, wie viel Fläche das Zeichen
 * innerhalb seines Feldes tatsächlich füllt. Im 24er-Feld läuft `arrow-left`
 * von x=5 bis x=19 und y=5 bis y=19, füllt also 14 von 24 in beide Richtungen.
 * `bell` reicht von x≈3,3 bis x≈20,7 und von y=2 bis y=21 — 17,5 breit und 19
 * hoch. Die Glocke ist im selben Feld also deutlich größer gezeichnet.
 *
 * Auf gleiche Kantenlänge gebracht:
 *
 *   Pfeil  @26  →  15,2 × 15,2 Punkte Zeichenfläche
 *   Glocke @26  →  19,0 × 20,6   (ein Drittel höher — sichtbar der Größere)
 *   Glocke @19  →  13,9 × 15,0   (praktisch deckungsgleich mit dem Pfeil)
 *
 * Die 19 des Landingscreens sind daneben also nicht zu klein, sondern genau
 * richtig — sie sind der Wert, bei dem sich die beiden entsprechen.
 */
const BELL_ICON_SIZE = 19;

/**
 * Datums-Sprachen — dieselbe Tabelle wie im Such-Screen (`SearchHero.tsx`).
 *
 * Bewusst nicht aus dem Store abgeleitet oder dynamisch importiert: `date-fns`
 * bündelt seine Sprachdateien einzeln, und ein `import()` zur Laufzeit hieße,
 * dass die Zeile beim ersten Bild ohne Datum steht und einen Takt später
 * umspringt. Vier statische Einträge kosten nichts.
 */
const DATE_LOCALES: Record<string, DateLocale> = {
  en: enUS,
  de: deLocale,
  fr: frLocale,
  es: esLocale,
};

/**
 * Symbol je Verkehrsmittel — dieselbe Zuordnung wie `RH_MODE_ICON` im
 * Ergebnis-Screen. Flüge weichen davon ab und bekommen das STARTENDE Flugzeug:
 * Der Kopf beschreibt eine Hinfahrt, kein Verkehrsmittel im Allgemeinen, und
 * genau so hält es auch das Abfahrts-Feld im Such-Screen.
 */
const MODE_ICON: Record<TravelMode, LucideIcon> = {
  FLIGHT: Plane,
  TRAIN: Train,
  BUS: Bus,
  CRUISE: Ship,
};

/**
 * Trenner zwischen den beiden Orten: Halbgeviertstrich MIT Leerzeichen.
 *
 * Kein Bindestrich („Berlin-Teneriffa" liest sich als ein zusammengesetzter
 * Ortsname) und kein Strich ohne Leerzeichen — die Zeile wird auf ein Bildschirm
 * abgeschnitten, und ein Umbruch fällt nur an einem Leerzeichen sauber.
 */
const ROUTE_SEP = " – ";

/** Trenner der Eckdaten-Zeile. */
const META_SEP = " · ";

/**
 * Höhe der Zeile OHNE die Außenabstände (`marginTop`/`marginHorizontal`).
 *
 * Beide Nachbarn der Box sind NIEDRIGER als sie: Pfeil und Glocke sitzen im
 * selben 26er-Feld (`ICON_BOX`), die Box misst 56. Seit die Glocke ihre
 * 44er-Scheibe verloren hat, ist der Abstand sogar größer als vorher — an der
 * Zeilenhöhe ändert das nichts, sie war schon davor die der Box.
 *
 * Und keiner der beiden zieht sich auf: Die Zeile richtet über
 * `alignItems: "center"` aus, nicht über `stretch`, und der `hitSlop`
 * vergrößert nur die Trefferfläche, nicht die Ausdehnung im Layout. In der
 * Zeile steht jetzt nichts mehr, was über sein Feld hinausragen könnte — der
 * Punkt für Ungelesenes ist entfallen.
 *
 * Der Ergebnis-Screen rechnet damit aus, wo die Such-Slide aufhören muss —
 * deshalb steht der Wert hier und nicht als Zahl dort.
 *
 * SCHON SKALIERT — wie `HOME_HEADER_H` in `lib/theme/spacing.ts` und aus
 * demselben Grund: Der Wert wird als POSITION verrechnet und läuft durch kein
 * Stilblatt. Wer ihn in ein `scaledStyles`-Blatt legt, bekommt den Faktor ein
 * zweites Mal — auf einem kurzen Gerät aus 56 erst 45 und dann 36.
 */
export const SUMMARY_BAR_H = ms(FIELD_H);

export interface SearchSummaryBarProps {
  mode: TravelMode;
  /** Schon aufbereitet, z.B. „Berlin (BER)" — hier wird nichts mehr gekürzt. */
  fromLabel: string;
  toLabel: string;
  /** ISO „yyyy-MM-dd", "" wenn unbekannt. */
  departDate: string;
  /** ISO, "" = einfache Fahrt. */
  returnDate: string;
  passengers: number;
  /** i18n-SCHLÜSSEL (z.B. „search.class.economy") oder "". */
  travelClassKey: string;
  /**
   * Zurück zum Landingscreen.
   *
   * Pflicht, nicht optional: Der Pfeil ist der EINZIGE sichtbare Ausgang dieses
   * Bildschirms. Die Tab-Leiste liegt darunter und ist von hier aus nicht
   * erreichbar — eine Zeile ohne `onBack` wäre eine Sackgasse, und das darf man
   * nicht versehentlich bauen können.
   */
  onBack: () => void;
  /**
   * Läuft beim AUFSETZEN des Fingers auf den Pfeil, nicht beim Loslassen.
   *
   * Gedacht für Vorbereitungen, die vor dem Start der Rückfahrt fertig sein
   * müssen — im Ergebnis-Screen ist das die bildschirmfüllende GPU-Ebene der
   * Liste. Optional, weil die Zeile für sich genommen ohne auskommt; wer sie
   * über eine fahrende Liste setzt, sollte sie füllen.
   */
  onBackTouchStart?: () => void;
  /** Öffnet die Such-Slide. */
  onPress: () => void;
  onBellPress: () => void;
}

/**
 * Kompakte Kopfzeile der Ergebnisliste: eine flache Box mit Strecke und
 * Eckdaten, rechts daneben die Glocke.
 *
 * Ganz links steht der Zurück-Pfeil. Er ist nicht Zierde, sondern Ersatz: Der
 * alte `RouteHeader` trug rechts einen „Ändern"-Knopf, und der war zugleich der
 * einzige sichtbare Weg zurück zum Landingscreen. Die kompakte Box übernimmt
 * seine eine Hälfte (das Formular öffnen), der Pfeil die andere (den Bildschirm
 * verlassen) — ohne ihn wäre der Ausgang beim Umbau ersatzlos verschwunden.
 *
 * Sie ersetzt den großen `RouteHeader` mit seinen zwei Eingabefeld-Attrappen.
 * Der Grund ist Fläche: Dieser Kopf steht ÜBER der Liste, dauerhaft, und hat
 * bisher fast ein Drittel des ersten Bildschirms für Angaben verbraucht, die
 * beim Suchen bereits gemacht wurden. Er zeigt jetzt nur noch, WAS gesucht
 * wurde, und ist der Weg zurück ins Formular.
 *
 * KEIN TAUSCH-KNOPF, und das ist eine Entscheidung, kein Versehen: Das Drehen
 * der Strecke lebt künftig ausschließlich in der Such-Slide, die beim Antippen
 * der Box herunterfährt. Hier war es teuer erkauft — jeder Tausch löste sofort
 * eine echte Anbieter-Suche aus und brauchte dafür eine Sperre gegen
 * Doppel-Tipper, einen Zeitgeber, damit die Drehung nicht in den Ladevorgang
 * jankt, und eine Freigabe, die auch dann greift, wenn die Suche gar nicht erst
 * startet. Wer ihn hier vermisst: Er ist eine Slide weiter, ohne diese Kette.
 *
 * `memo`, mit derselben Begründung wie beim alten `RouteHeader`: Dieser Kopf
 * hängt an wenigen Werten, der Bildschirm darunter wechselt seinen Zustand aber
 * mehrfach pro Übergang (Bereitschaft am Slide-Ende, Eintreffen der Daten,
 * Sortierung, Richtung). Ohne memo liefe dieser Baum bei JEDEM dieser Wechsel
 * neu — einer davon fällt exakt auf das Ende der Bewegung.
 */
export const SearchSummaryBar = memo(function SearchSummaryBar({
  mode,
  fromLabel,
  toLabel,
  departDate,
  returnDate,
  passengers,
  travelClassKey,
  onBack,
  onBackTouchStart,
  onPress,
  onBellPress,
}: SearchSummaryBarProps) {
  const t = useT();
  const palette = usePalette();
  const locale = useSearchStore((s) => s.locale);
  const dateLocale = DATE_LOCALES[locale] ?? enUS;

  const Icon = mode === "FLIGHT" ? PlaneTakeoff : MODE_ICON[mode];

  /**
   * `parseISO`, NICHT `new Date(iso)`.
   *
   * Beide schlucken „2026-04-26", aber sie meinen Verschiedenes: Der Konstruktor
   * liest ein reines Datum als UTC-Mitternacht, und in jeder Zone westlich von
   * Greenwich steht dann der Vortag auf dem Bildschirm — die Suche vom 26. wird
   * zum 25. `parseISO` liest es als lokale Mitternacht. Dieselbe Stelle steht
   * schon in `RecentCard.tsx` und `DetailsOverlay.tsx`.
   *
   * Das `try` fängt nur den Fall ab, dass von außen etwas anderes als ein
   * ISO-Datum hereinkommt; dann steht lieber die Rohform da als „Invalid Date".
   */
  const fmtDate = (iso: string): string => {
    if (!iso) return "";
    try {
      // „d. MMM" ist NICHT frei gewählt: Genau dieses Muster benutzen
      // RecentCard, DetailsOverlay und LegTimelineOverlay. Dasselbe Datum darf
      // nicht an zwei Stellen der App verschieden aussehen — der Punkt hinter
      // dem Tag ist im Englischen zwar untypisch, ein vierter Datums-Stil wäre
      // aber der schlechtere Tausch.
      return format(parseISO(iso), "d. MMM", { locale: dateLocale });
    } catch {
      return iso;
    }
  };

  const departLabel = fmtDate(departDate);
  const returnLabel = fmtDate(returnDate);
  const dateLabel =
    departLabel && returnLabel
      ? `${departLabel}${ROUTE_SEP}${returnLabel}`
      : departLabel;

  const paxLabel =
    passengers > 0
      ? `${passengers} ${t(passengers === 1 ? "search.pax.one" : "search.pax.many")}`
      : "";
  const classLabel = travelClassKey ? t(travelClassKey) : "";

  const routeLabel = `${fromLabel}${ROUTE_SEP}${toLabel}`;
  /**
   * Leere Teile fallen ERSATZLOS weg.
   *
   * Naheliegend wäre eine feste Kette mit drei Trennern. Fehlt dann eines der
   * Stücke — bei einer Zug-Suche ohne Klasse etwa, oder wenn das Datum noch
   * offen ist — steht ein nacktes „ · " in der Zeile, und das liest sich wie ein
   * Ladefehler. Deshalb erst sammeln, dann fügen.
   */
  const metaLabel = [dateLabel, paxLabel, classLabel].filter(Boolean).join(META_SEP);

  return (
    <View style={styles.row}>
      {/* Freistehend, ohne Kreis und ohne Fläche — so wie das X in allen
          Blättern der App. Ein umrandeter Knopf hätte hier zwei Flächen
          nebeneinander gesetzt (Pfeil und Box) und die Box damit zu einer von
          zweien gemacht, statt zum Inhalt der Zeile. */}
      {/**
        * `Pressable` statt `RippleTouch` — und das ist kein Stilbruch, sondern
        * die Bedingung dafür, dass die Rückfahrt glatt läuft.
        *
        * Dieser Pfeil ist der Haupt-Ausgang der Ergebnisliste, und die fährt
        * hinaus, während sie noch ihren vollen Inhalt trägt: zwanzig Karten mit
        * Logos und Verläufen. Ohne GPU-Ebene wird das in JEDEM Bild der Ausfahrt
        * neu gezeichnet — deshalb fordert `onBackTouchStart` sie beim AUFSETZEN
        * des Fingers an. Ihr Aufbau ist im Projekt mit 66ms vermessen, das
        * gehört in die 80 bis 150ms, die zwischen Aufsetzen und Loslassen
        * ohnehin vergehen, und nicht in die ersten Bilder der Bewegung.
        *
        * Und genau deshalb keine Material-Welle: Die läuft beim LOSLASSEN aus,
        * also mitten in die eben angelegte Ebene hinein, die sie dann Bild für
        * Bild ungültig machen würde. Mit Welle wäre die Ebene schlechter als
        * gar keine. Dieselbe Begründung wie an den Schließ-Knöpfen von
        * Detail-Blatt und Profil-Unterschirm — und sie stand wörtlich an dem
        * „Ändern"-Knopf, dessen Aufgabe dieser Pfeil übernommen hat.
        */}
      <Pressable
        style={ICON_BOX}
        hitSlop={ICON_HIT_SLOP}
        onTouchStart={onBackTouchStart}
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel={t("common.back")}
      >
        <ArrowLeft size={CLOSE_ICON_SIZE} color={C.closeIcon} strokeWidth={2} />
      </Pressable>

      <RippleTouch
        style={[styles.box, { backgroundColor: palette.s2 }]}
        onPress={onPress}
        // Der sichtbare Text wird von der Beschriftung verdeckt, sobald eine
        // gesetzt ist — deshalb steht er hier vollständig drin, samt Hinweis auf
        // das, was ein Tipp bewirkt.
        accessibilityLabel={[routeLabel, metaLabel, t("results.summary.edit")]
          .filter(Boolean)
          .join(". ")}
      >
        <Icon size={20} color={C.sub} strokeWidth={1.9} />
        {/* `minWidth: 0` an der Textspalte: Ohne das weigert sich ein
            Flex-Kind zu schrumpfen und schiebt die Glocke aus dem Bild, statt
            die lange Strecke abzuschneiden. */}
        <View style={styles.texts}>
          <Text style={styles.route} numberOfLines={1}>
            {routeLabel}
          </Text>
          {metaLabel ? (
            <Text style={styles.meta} numberOfLines={1}>
              {metaLabel}
            </Text>
          ) : null}
        </View>
      </RippleTouch>

      {/**
        * Die Glocke steht FREI — kein Kreis, keine Fläche, kein Radius.
        *
        * Im Landingscreen sitzt sie in einer 44er-Scheibe in Kartenfarbe, und
        * dort ist das richtig: Sie ist das einzige Bedienelement einer sonst
        * leeren Kopfzeile und braucht etwas, das sie als Knopf ausweist. Hier
        * steht sie am Ende einer Zeile, deren Mitte bereits eine gefüllte Box
        * ist — eine zweite Fläche daneben hätte aus einer Box mit zwei Zeichen
        * drei konkurrierende Flächen gemacht. Sie folgt jetzt dem Pfeil auf der
        * anderen Seite und dem X in allen Blättern der App: nur das Zeichen.
        *
        * `borderless` bleibt: Die Welle soll sich kreisförmig über das Zeichen
        * ausbreiten, nicht in einem Rechteck stehen bleiben, das gar nicht mehr
        * zu sehen ist.
        */}
      <RippleTouch
        style={ICON_BOX}
        hitSlop={ICON_HIT_SLOP}
        borderless
        onPress={onBellPress}
        accessibilityLabel={t("notifications.title")}
      >
        <Bell size={BELL_ICON_SIZE} color={C.text} />
      </RippleTouch>
    </View>
  );
});

const styles = scaledStyles({
  row: {
    flexDirection: "row",
    alignItems: "center",
    /**
     * EIN Abstand für beide Lücken — und daraus folgt die Symmetrie der Box.
     *
     * Verlangt ist, dass die Box links wie rechts gleich weit vom
     * Bildschirmrand steht. Das ist nicht dasselbe wie „gleicher Rand": Zwischen
     * Rand und Box steht auf beiden Seiten noch ein Zeichen. Die Rechnung geht
     * also über die ganze Zeile:
     *
     *   links   GUTTER (20) + Feld (26) + gap (12)  =  58
     *   rechts  gap (12) + Feld (26) + GUTTER (20)  =  58
     *
     * Der Rest gehört der Box (`flex: 1`), und sie sitzt damit exakt mittig.
     *
     * Beide Summen stimmen nur überein, weil Pfeil und Glocke in einem
     * gemeinsamen, gleich breiten Feld sitzen (`ICON_BOX`). Ohne das wäre die
     * linke Seite 26 breit und die rechte 19 — die Box stünde 7 Punkte zu weit
     * links, und man würde es sehen, ohne es benennen zu können. Wer das Feld
     * für überflüssig hält, weil ja beide Zeichen „gleich aussehen": Genau das
     * tun sie, aber ihre Kantenlängen unterscheiden sich (siehe
     * `BELL_ICON_SIZE`).
     */
    gap: SPACE.md,
    marginHorizontal: GUTTER,
    // Derselbe Wert, den das alte `routePanel` oben hatte — der Abstand zur
    // Kopfzeile darüber ändert sich durch den Umbau nicht.
    marginTop: SPACE.md,
  },
  box: {
    flex: 1,
    minWidth: 0,
    // Höhe und Radius sind die der EINGABEFELDER (`rhField`): Es ist dieselbe
    // Strecke, einmal zum Eingeben und einmal zum Anzeigen. Die Box ist der
    // Ausgangspunkt der Such-Slide, und sie soll sich lesen wie das Feld, das
    // beim Antippen an ihre Stelle tritt.
    height: FIELD_H,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACE.lg,
    gap: SPACE.md,
  },
  texts: { flex: 1, minWidth: 0 },
  route: {
    fontSize: 14,
    fontWeight: "700",
    color: C.text,
  },
  meta: {
    fontSize: 12,
    fontWeight: "600",
    color: C.sub,
    marginTop: SPACE.xs,
  },
});
