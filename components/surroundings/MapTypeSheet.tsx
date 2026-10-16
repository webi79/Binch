import { memo, useCallback } from "react";
import { Text, View } from "react-native";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { Check } from "lucide-react-native";
import { haptic } from "@/lib/haptics";
import { useT } from "@/lib/i18n/useT";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { SPACE } from "@/lib/theme/spacing";
import { scaledStyles } from "@/lib/ui/compact";
import { SheetModal, SHEET_SUBTITLE, SHEET_TITLE } from "@/components/ui/SheetModal";
import { BinchSwitch } from "@/components/ui/BinchSwitch";
import { DARK_PALETTE, LIGHT_PALETTE, type MapPalette } from "@/components/surroundings/mapStyle";
import { useSearchStore } from "@/stores/searchStore";
import { useResolvedMapStyle, type MapStyleChoice } from "@/lib/theme/mapStyleChoice";

/**
 * Das Blatt für den Kartentyp — erreichbar über den obersten Knopf der
 * Karten-Knopfreihe.
 *
 * AUFBAU wie in jedem anderen Blatt dieser App: `SheetModal` liefert
 * Verdunkelung, Griffstrich, Rundung, seitliches Polster und die Wisch-Geste;
 * hier drin steht nur der Inhalt. Titel und Unterzeile kommen aus den geteilten
 * Vorlagen (`SHEET_TITLE`/`SHEET_SUBTITLE`), damit dieses Blatt nicht anders
 * beschriftet ist als die vier bestehenden.
 *
 * Die Auswahl-KACHEL ist bewusst dieselbe wie die Themen-Auswahl in den
 * Einstellungen (`settings.tsx`): zwei Lagen, deren äußere mit vier Punkten
 * Polster den Akzentrahmen BILDET, innen eine Vorschau und darunter eine Zeile
 * mit Beschriftung und Häkchen. Der Nutzer hat dieses Muster dort schon
 * gelernt — es ist dieselbe Frage („welches Aussehen?"), also dieselbe Gestalt.
 *
 * ANGEWANDT WIRD SOFORT, nicht erst beim Schließen. Die übrigen Blätter dieser
 * App sammeln ihre Änderung und übernehmen sie beim Hinausfahren (das
 * `applied`-Ref-Muster), weil ein Commit mitten in der Bewegung auf Fabric
 * ruckelt. Hier ist es umgekehrt richtig: Die Karte liegt HINTER dem Blatt, und
 * der ganze Sinn der Auswahl ist, sie sich ansehen zu können. Der Tipp fällt
 * dabei nicht in eine Bewegung — das Blatt steht.
 */

const C = { white: "#F4F4F5", sub: "#8E8E93" };

/** Die drei Kacheln, in der Reihenfolge des Bildes. */
const TYPES: { id: Exclude<MapStyleChoice, "auto">; key: string }[] = [
  { id: "dark", key: "map.type.dark" },
  { id: "light", key: "map.type.light" },
  { id: "satellite", key: "map.type.satellite" },
];

/**
 * Die Vorschau in der Kachel — gezeichnet, nicht fotografiert.
 *
 * Sie besteht aus denselben Farben, die der Stil wirklich benutzt: Grund,
 * Wasser, Grünfläche und zwei Straßenbreiten. Damit kann die Vorschau nicht
 * lügen, wenn jemand später eine Palette ändert — sie liest dieselben Werte.
 * Ein echtes Kachelbild wäre hübscher, müsste aber geladen werden und wäre in
 * dem Moment falsch, in dem sich der Stil ändert.
 */
const StylePreview = memo(function StylePreview({ palette }: { palette: MapPalette }) {
  return (
    <View style={[s.preview, { backgroundColor: palette.bg }]}>
      {/* Wasser läuft von unten links herein — wie auf einer Stadtkarte. */}
      <View style={[s.previewWater, { backgroundColor: palette.water }]} />
      <View style={[s.previewPark, { backgroundColor: palette.park }]} />
      {/* Zwei Straßen: eine breite Hauptachse, eine schmale quer dazu. */}
      <View style={[s.previewRoadWide, { backgroundColor: palette.roadTrunk }]} />
      <View style={[s.previewRoadThin, { backgroundColor: palette.roadSecondary }]} />
    </View>
  );
});

/**
 * Satellit hat keine Palette — er ist ein Luftbild.
 *
 * Deshalb hier eine angedeutete Landschaft aus gedeckten Tönen statt echter
 * Farbwerte: Ein Bild wäre die Wahrheit, aber es müsste geladen werden, und
 * eine Kachel, die erst nach einer Sekunde erscheint, sieht kaputt aus.
 */
const SatellitePreview = memo(function SatellitePreview() {
  return (
    <View style={[s.preview, { backgroundColor: "#3B4A3A" }]}>
      <View style={[s.previewWater, { backgroundColor: "#2C3E4C" }]} />
      <View style={[s.previewPark, { backgroundColor: "#4A5C42" }]} />
      <View style={[s.previewRoadWide, { backgroundColor: "#8A8478" }]} />
      <View style={[s.previewRoadThin, { backgroundColor: "#6E6A61" }]} />
    </View>
  );
});

function MapTypeBody() {
  const t = useT();
  const accent = useAccent();
  const palette = usePalette();
  const setMapStyleChoice = useSearchStore((st) => st.setMapStyleChoice);
  /**
   * Hervorgehoben wird der TATSÄCHLICH gezeigte Stil, nicht der gespeicherte
   * Wert. Die Vorgabe ist „auto", und die ist keine vierte Kachel — sie
   * bedeutet „dunkel oder hell, je nach Thema". Die Kachel muss zeigen, was auf
   * dem Schirm liegt, sonst steht sie im Widerspruch zur Karte dahinter.
   */
  const resolved = useResolvedMapStyle();
  const choice = useSearchStore((st) => st.mapStyleChoice);
  const buildings3d = useSearchStore((st) => st.mapBuildings3d);
  const setBuildings3d = useSearchStore((st) => st.setMapBuildings3d);
  /**
   * Im Luftbild gibt es keine Häuser zum Aufstellen — sie stehen schon im Bild.
   * Und die Kombination brachte die App zum Absturz; die Karte zeichnet sie
   * dort deshalb ohnehin nicht (siehe `surroundings.tsx`). Der Schalter sagt
   * das, statt es den Nutzer ausprobieren zu lassen.
   */
  const buildingsBlocked = resolved === "satellite";
  /** Gesperrt heißt auch: sichtbar AUS, egal was gespeichert ist. */
  const buildingsOn = buildings3d && !buildingsBlocked;
  const toggleBuildings = useCallback(() => {
    haptic("button");
    setBuildings3d(!buildings3d);
  }, [buildings3d, setBuildings3d]);

  /**
   * Dieselbe Kachel noch einmal antippen führt ZURÜCK auf „automatisch".
   *
   * Der Speicher verspricht genau das, und ohne diese Zeile wäre es eine Lüge
   * gewesen: Nach dem ersten Tipp stand dort für immer ein fester Stil, und die
   * Kopplung an das Thema war über keine Bedienung mehr erreichbar. Wer sein
   * Thema von hell auf dunkel stellt, bekäme die Karte nie wieder mit.
   *
   * Verglichen wird gegen die WAHL, nicht gegen das aufgelöste Ergebnis: Steht
   * „automatisch" und ist daraus gerade „dunkel" geworden, soll ein Tipp auf
   * „Dunkel" ihn festhalten und nicht abschalten.
   */
  const pick = useCallback(
    (id: Exclude<MapStyleChoice, "auto">) => {
      haptic("button");
      setMapStyleChoice(choice === id ? "auto" : id);
    },
    [choice, setMapStyleChoice],
  );

  return (
    <>
      <Text style={s.title}>{t("map.type.title")}</Text>
      <Text style={s.subtitle}>{t("map.type.subtitle")}</Text>

      <View style={s.row}>
        {TYPES.map((type) => {
          const active = resolved === type.id;
          return (
            /**
             * Welle (`RippleTouch`) statt `Pressable`: Deren React-Zustand
             * „gedrückt" rendert beim Aufsetzen und beim Abbruch neu — wer das
             * Blatt an einer Karte herunterzieht, bekam diesen Durchgang mitten
             * in die Bewegung (siehe `startDragHeal` in lib/ui/sheetSwipe.ts).
             *
             * Stil als ARRAY, nicht als Funktion: An einer `Pressable` kommt
             * eine Stil-FUNKTION in diesem Projekt gar nicht an — NativeWinds
             * JSX-Umschreibung verschluckt sie stumm (dokumentiert in
             * `SearchBar.tsx`). Genau dieselbe Zeile steht im Vorbild in den
             * Einstellungen.
             */
            <RippleTouch
              key={type.id}
              onPress={() => pick(type.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[s.cardOuter, { backgroundColor: active ? accent.solid : "transparent" }]}
            >
              <View
                style={[s.cardInner, { borderColor: active ? "transparent" : palette.border }]}
              >
                {type.id === "satellite" ? (
                  <SatellitePreview />
                ) : (
                  <StylePreview palette={type.id === "dark" ? DARK_PALETTE : LIGHT_PALETTE} />
                )}
                <View style={[s.footer, { backgroundColor: active ? accent.solid : palette.s2 }]}>
                  <Text
                    style={[s.footerText, { color: active ? accent.textOnSolid : C.white }]}
                    numberOfLines={1}
                  >
                    {t(type.key)}
                  </Text>
                  {active ? <Check size={14} color={accent.textOnSolid} strokeWidth={2.6} /> : null}
                </View>
              </View>
            </RippleTouch>
          );
        })}
      </View>

      {/* Dieselbe Trennlinie wie im Alarm-Blatt: eine Haarlinie in der
          Rahmenfarbe, mit gleichem Abstand nach oben und unten. */}
      <View style={[s.divider, { backgroundColor: palette.border }]} />

      <Text style={s.section}>{t("map.details.title")}</Text>

      {/**
        * Die ganze Zeile schaltet, nicht nur der Schalter — dieselbe Zeile wie
        * im Alarm-Blatt und auf der Alarm-Karte. Deshalb steht der Schalter auf
        * `readOnly`: Sonst zählte ein Tipp doppelt, einmal über die Zeile und
        * einmal über ihn selbst.
        */}
      <RippleTouch
        onPress={toggleBuildings}
        disabled={buildingsBlocked}
        accessibilityRole="switch"
        accessibilityState={{ checked: buildingsOn, disabled: buildingsBlocked }}
        /**
         * Gesperrt wird GEDIMMT, nicht versteckt.
         *
         * Eine Zeile, die im Luftbild-Modus einfach verschwände, sähe aus wie
         * ein Fehler — man sucht die Einstellung, die man vorhin noch hatte.
         * Sichtbar und erklärt ist ehrlicher: Der Hinweis darunter sagt, warum
         * sie gerade nicht geht.
         */
        style={[s.detailRow, buildingsBlocked ? s.detailRowOff : null]}
      >
        <View style={s.detailText}>
          <Text style={s.detailLabel}>{t("map.details.buildings")}</Text>
          <Text style={s.detailHint}>
            {t(buildingsBlocked ? "map.details.buildings.satellite" : "map.details.buildings.hint")}
          </Text>
        </View>
        <BinchSwitch value={buildingsOn} readOnly />
      </RippleTouch>
    </>
  );
}

export function MapTypeSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  /**
   * `onClose` muss vom Aufrufer FEST sein — eine neue Funktion pro Durchgang
   * richtet in der Hülle Wisch-Geste und Zurück-Taste-Merker mitten in der
   * Bewegung neu ein (siehe `SheetModal`).
   */
  return (
    <SheetModal visible={visible} onClose={onClose}>
      {() => <MapTypeBody />}
    </SheetModal>
  );
}

const s = scaledStyles({
  title: { ...SHEET_TITLE, marginBottom: SPACE.sm },
  subtitle: { ...SHEET_SUBTITLE, marginBottom: SPACE.lg },
  /** Dieselbe Reihe wie die Themen-Auswahl: drei gleiche Teile, 10 Abstand. */
  row: { flexDirection: "row", gap: 10 },
  /** Die vier Punkte Polster SIND der Akzentrahmen — siehe Vorbild. */
  cardOuter: { flex: 1, borderRadius: 18, padding: 4 },
  cardInner: { borderRadius: 14, overflow: "hidden", borderWidth: 1 },
  /**
   * 76 hoch statt 72 wie in den Einstellungen: Dort steht neben der Kachel ein
   * erklärender Text, hier tragen drei Kacheln die ganze Zeile. Eine Vorschau,
   * die fast quadratisch ist, liest sich als Karte; eine flache als Balken.
   */
  preview: { height: 76, overflow: "hidden" },
  previewWater: {
    position: "absolute",
    left: -14,
    bottom: -18,
    width: 46,
    height: 40,
    borderRadius: 20,
  },
  previewPark: {
    position: "absolute",
    right: -10,
    top: -8,
    width: 34,
    height: 30,
    borderRadius: 14,
  },
  previewRoadWide: {
    position: "absolute",
    left: -6,
    right: -6,
    top: 30,
    height: 5,
    transform: [{ rotate: "-9deg" }],
  },
  previewRoadThin: {
    position: "absolute",
    top: -6,
    bottom: -6,
    left: 30,
    width: 3,
    transform: [{ rotate: "12deg" }],
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: SPACE.sm,
    paddingVertical: 9,
    gap: SPACE.xs,
  },
  footerText: { fontSize: 13, fontWeight: "700", flexShrink: 1 },
  divider: { height: 1, marginTop: SPACE.xl, marginBottom: SPACE.lg },
  section: { ...SHEET_TITLE, fontSize: 17, marginBottom: SPACE.md },
  detailRow: { flexDirection: "row", alignItems: "center", gap: SPACE.md, minHeight: 44 },
  /** `opacity` wird von `scaledStyles` nicht angefasst — sie ist kein Maß. */
  detailRowOff: { opacity: 0.45 },
  detailText: { flex: 1, minWidth: 0 },
  detailLabel: { fontSize: 15, fontWeight: "600", color: C.white },
  detailHint: { ...SHEET_SUBTITLE, marginTop: 2 },
});
