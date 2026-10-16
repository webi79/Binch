import { memo, useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Bus, Heart, Plane, Ship, Train, type LucideIcon } from "lucide-react-native";
import { showAlert } from "@/lib/alert";
import { haptic } from "@/lib/haptics";
import { useRouteMeta } from "@/lib/format/routeMeta";
import { SHEET_OUT } from "@/lib/nav/overlayCover";
import { isPastDate, isStale, openAlertRoute } from "@/lib/nav/openAlertRoute";
import { useT } from "@/lib/i18n/useT";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { GUTTER, SPACE } from "@/lib/theme/spacing";
import { scaledStyles } from "@/lib/ui/compact";
import { ClearSearchHistoryAlert } from "@/components/ui/ClearSearchHistoryAlert";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useSearchStore } from "@/stores/searchStore";
import type { AlertHit } from "@/types/saved";
import type { TravelMode } from "@/types/search";

/**
 * Die Alarme, die AUSGELÖST haben — der Inhalt der Glocke.
 *
 * Hier standen bis eben die gesetzten Alarme selbst, und das war falsch herum:
 * Eine Glocke zeigt, was passiert IST. Ein gesetzter Alarm ist eine stehende
 * Beobachtung und gehört zu den gespeicherten Reisen; erst wenn er anschlägt,
 * entsteht ein Ereignis — mit Zeitpunkt, Preis und Änderung.
 *
 * Die Zahlen kommen aus dem DATENTEIL der Meldung, nicht aus ihrem Text. Den
 * wieder auseinanderzunehmen hieße, gekürzte Ortsnamen und Währungszeichen
 * zurückzurechnen — ein Parser, der bei jeder Textänderung still bricht.
 */

const MODE_ICON: Record<TravelMode, LucideIcon> = {
  FLIGHT: Plane,
  TRAIN: Train,
  BUS: Bus,
  CRUISE: Ship,
};

const C = {
  text: "#F4F4F5",
  sub: "#8E8E93",
  rise: "#FF3B5C",
  /** Das Rot der gemerkten Reise — derselbe Wert wie in `ResultCard`. */
  heart: "#FF3B5C",
};

function Card({ hit }: { hit: AlertHit }) {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  const { metaLine, routeLine, fmtDate } = useRouteMeta();
  const removeAlertHit = useSearchStore((s) => s.removeAlertHit);
  /**
   * Steht die Rückfrage offen? Als Zustand DIESER Karte — in der Liste stehen
   * beliebig viele, und ein geteilter Zustand weiter oben müsste zusätzlich
   * mitführen, welche gemeint ist.
   */
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** Liegt gerade ein Finger auf der Karte? Siehe die Begründung am `style`. */
  const [pressed, setPressed] = useState(false);
  const closeNotifications = useSearchStore((s) => s.closeNotifications);
  const Icon = MODE_ICON[hit.mode] ?? Train;

  /**
   * Die Suche aus der Meldung heraus öffnen — mit denselben Parametern, die der
   * Alarm trug.
   *
   * Über `openAlertRoute`, also exakt den Weg, den auch ein Tipp auf die
   * Push-Meldung nimmt. Zwei Fassungen davon öffneten sonst zwei verschiedene
   * Suchen — eine für eine Person, eine für vier —, und die Preise sagten
   * jeweils etwas anderes.
   *
   * DAS BLATT MUSS ERST WEG SEIN, und deshalb steht hier ein Wecker.
   *
   * Am Wurzel-Layout wird die Ergebnisliste VOR diesem Blatt gezeichnet
   * (`app/_layout.tsx`), das Blatt liegt also darüber. Beides gleichzeitig zu
   * starten hieße: Die Liste fährt unsichtbar dahinter ein, und wenn das Blatt
   * nach 260ms fort ist, steht sie einfach da. Die ganze Bewegung wäre umsonst
   * gelaufen und sähe wie ein Sprung aus.
   *
   * Die Wartezeit ist deshalb genau die Ausfahrt des Blattes (`SHEET_OUT`) und
   * keine gegriffene Zahl — ändert jemand dort die Dauer, wandert sie hier mit.
   */
  const openSearch = useCallback(() => {
    closeNotifications();
    setTimeout(() => openAlertRoute({
      mode: hit.mode,
      origin: hit.origin,
      destination: hit.destination,
      originLabel: hit.originLabel,
      destLabel: hit.destLabel,
      departDate: hit.departDate,
      returnDate: hit.returnDate,
      passengers: hit.passengers,
      travelClass: hit.travelClass,
      currency: hit.currency,
    }), SHEET_OUT.duration);
  }, [closeNotifications, hit]);

  /**
   * Zwei Fälle stehen vor der Suche, und beide sind Ehrlichkeitsfragen.
   *
   * VERGANGENHEIT: Eine Abfahrt, die schon war, lässt sich nicht mehr suchen.
   * Die Liste käme leer zurück, und das sähe nach einem Fehler aus statt nach
   * einem abgelaufenen Datum. Hier wird deshalb gar nicht erst gesucht, sondern
   * gesagt warum — mit dem Angebot, die Meldung wegzuräumen.
   *
   * ÜBERHOLTER PREIS: Die Karte nennt einen Betrag von damals. Ist die Meldung
   * älter als eine halbe Entprellungsspanne, ist die Wahrscheinlichkeit größer,
   * dass er nicht mehr gilt, als dass er es tut. Die Suche wird trotzdem
   * angeboten — sie liefert ja gerade den aktuellen Preis —, aber nicht
   * kommentarlos: Wer die 89 € aus der Karte erwartet und 140 € vorfindet, hält
   * die App für kaputt. Wir schätzen keine Preise, und ein alter Preis ist eine
   * Schätzung über die Gegenwart.
   */
  const onCardPress = useCallback(() => {
    haptic("button");
    if (isPastDate(hit.departDate)) {
      showAlert(
        t("alert.hits.past.title"),
        t("alert.hits.past.body").replace("{date}", fmtDate(hit.departDate)),
        [
          { text: t("common.cancel"), style: "cancel" },
          { text: t("alert.hits.remove.confirm"), style: "destructive", onPress: () => removeAlertHit(hit.id) },
        ],
      );
      return;
    }
    if (isStale(hit.receivedAt)) {
      showAlert(
        t("alert.hits.stale.title"),
        t("alert.hits.stale.body").replace("{date}", fmtDate(hit.receivedAt.slice(0, 10))),
        [
          { text: t("common.cancel"), style: "cancel" },
          { text: t("alert.hits.stale.confirm"), onPress: openSearch },
        ],
      );
      return;
    }
    openSearch();
  }, [fmtDate, hit, openSearch, removeAlertHit, t]);

  /**
   * Gefallen oder gestiegen — die FARBE trägt es, nicht ein Wort.
   *
   * Der Prozentsatz steht mit Vorzeichen da („-11 %"), genau wie in der
   * Meldung selbst. Grün für den Sturz, Rot für den Anstieg: dieselbe
   * Zuordnung wie beim Abzeichen im Alarm-Blatt, damit nicht zwei Stellen
   * dasselbe verschieden ausdrücken.
   */
  const dropped = hit.pct > 0;
  const pctColor = dropped ? accent.solid : C.rise;
  const pctText = `${dropped ? "-" : "+"}${Math.abs(hit.pct)}%`;

  return (
    /**
     * Die GANZE Karte ist tippbar — außer dem Herz.
     *
     * `Pressable` und nicht `RippleTouch`: Der Ripple liefe über die ganze
     * Kartenfläche und damit auch unter dem Herz hindurch, wo er eine zweite,
     * gar nicht ausgelöste Handlung andeutete. Die Rückmeldung ist stattdessen
     * ein kurzes Abdunkeln der Fläche.
     *
     * Das Herz liegt DARIN und fängt seinen Tipp selbst ab — eine `Pressable`
     * innerhalb einer `Pressable` gewinnt in React Native die innere. Ohne das
     * öffnete ein Tipp auf das Herz zusätzlich die Suche, also beides auf
     * einmal.
     */
    <Pressable
      onPress={onCardPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityRole="button"
      accessibilityLabel={routeLine(hit.originLabel, hit.destLabel)}
      /**
       * ARRAY, KEINE FUNKTION — und das ist kein Stilfrage.
       *
       * Mit `style={({pressed}) => [...]}` kam hier gar kein Stil an: Die Karte
       * verlor Fläche, Rundung UND Polster, der Text stand nackt auf dem Blatt
       * und die Trennlinie lief von Rand zu Rand. Diese Datei geht durch
       * NativeWinds JSX-Umschreibung, und die verträgt sich an dieser Stelle
       * nicht mit der Funktions-Form.
       *
       * Im Projekt ist das schon einmal passiert und in `SearchBar.tsx`
       * ausführlich beschrieben — dort verlor die Suchleiste Pillenform und
       * Hintergrund. Ich bin trotzdem hineingelaufen; deshalb steht es jetzt
       * auch hier.
       *
       * Der Gedrückt-Zustand kommt deshalb aus einem Zustand statt aus dem
       * Rückruf. Das kostet einen Durchgang DIESER Karte je Berührung — bei
       * höchstens fünfzig Einträgen, von denen immer nur einer gedrückt ist,
       * ist das nichts.
       */
      style={[styles.card, { backgroundColor: palette.s2 }, pressed && styles.cardPressed]}
    >
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.route} numberOfLines={2}>
            {routeLine(hit.originLabel, hit.destLabel)}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {metaLine({
              departDate: hit.departDate,
              returnDate: hit.returnDate,
              passengers: hit.passengers,
              travelClassKey: hit.travelClass,
            })}
          </Text>
        </View>
        {/**
          * DASSELBE Herz wie auf der Alarm-Karte — kein Kreuz.
          *
          * Hier stand eines, weil „wegräumen" die Handlung ist. Nebeneinander
          * gelegt waren es dann aber zwei Karten, die gleich aussehen und oben
          * rechts verschiedene Zeichen tragen — und der Nutzer sucht nach dem
          * Unterschied, den das bedeuten soll. Es gibt keinen: Beide Male nimmt
          * man etwas aus einer Liste.
          *
          * Größe, Farbe und Feld kommen deshalb Zahl für Zahl von dort, und die
          * Rückfrage ist dieselbe Karte.
          */}
        <RippleTouch
          onPress={() => setConfirmOpen(true)}
          hitSlop={8}
          accessibilityLabel={t("common.delete")}
          style={styles.heart}
        >
          <Heart size={18} color={C.heart} fill={C.heart} />
        </RippleTouch>
      </View>

      <View style={styles.divider} />

      {/**
        * DIESELBE Zeile wie auf der Alarm-Karte unter „Gespeichert" — nur mit
        * anderem Inhalt an der rechten Seite.
        *
        * Links das Verkehrsmittel im abgerundeten Feld und daneben eine
        * Beschriftung, rechts das, was die Zeile trägt. Dort steht auf der
        * Alarm-Karte der Schalter; hier stehen die Zahlen, denn ein ausgelöster
        * Alarm hat nichts mehr zu schalten — er ist erledigt.
        *
        * Die Beschriftung links ist das DATUM. Auf der Alarm-Karte steht dort
        * „Preis-Alarme", was hier nichts sagte (unter der Glocke ist ohnehin
        * alles ein Preis-Alarm). Wann die Meldung kam, ist dagegen genau die
        * Angabe, die in einer Chronik fehlt.
        */}
      <View style={styles.factRow}>
        <View style={styles.modeBox}>
          <Icon size={16} color={C.text} strokeWidth={2} />
        </View>
        <Text style={styles.when}>{fmtDate(hit.receivedAt.slice(0, 10))}</Text>
        {/**
          * ERST der Prozentsatz, DANN der Preis — und beide als EINE Gruppe.
          *
          * Die Reihenfolge macht aus der Zeile einen Satz: „zwölf Prozent
          * runter, auf 114 Euro". Die Änderung ist der Grund der Meldung, der
          * Preis ihr Ergebnis.
          *
          * Die eigene Hülle statt eines engeren Abstands am Text: Die Zeile
          * führt zwölf Punkte zwischen ihren Teilen, zwischen diesen beiden
          * sollen es acht sein, weil sie zusammengehören. Über einen negativen
          * Rand ginge das auch — aber dann stünde die Absicht nirgends, und wer
          * später den Zeilenabstand ändert, verschöbe unbemerkt auch diesen.
          */}
        <View style={styles.numbers}>
          <Text style={[styles.pct, { color: pctColor }]}>{pctText}</Text>
          <Text style={styles.price}>{`${Math.round(hit.price)} ${hit.currency}`}</Text>
        </View>
      </View>

      {/**
        * Die Rückfrage — dieselbe Karte wie beim Löschen eines Alarms.
        *
        * Der TEXT ist ein anderer, und das ist Absicht. Dort steht, der Alarm
        * werde auch auf dem Server gelöscht und melde nichts mehr. Hier wäre
        * das ein Versprechen über etwas, das längst erledigt ist: Der Alarm hat
        * ausgelöst und ist dabei auf beiden Seiten verschwunden. Was hier
        * verschwindet, ist die Meldung darüber.
        */}
      <ClearSearchHistoryAlert
        visible={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          removeAlertHit(hit.id);
        }}
        title={t("alert.hits.remove.title")}
        message={t("alert.hits.remove.body").replace(
          "{route}",
          routeLine(hit.originLabel, hit.destLabel),
        )}
        confirmLabel={t("alert.hits.remove.confirm")}
        cancelLabel={t("common.cancel")}
      />
    </Pressable>
  );
}

export const AlertHitList = memo(function AlertHitList() {
  const t = useT();
  const hits = useSearchStore((s) => s.alertHits);
  if (hits.length === 0) return null;

  return (
    <View style={styles.wrap}>
      {/**
        * Nur noch die Überschrift, kein „Leeren" daneben.
        *
        * Der Knopf stand hier, solange der Papierkorb in der Kopfzeile des
        * Blattes ins Leere griff — er leerte eine Liste, die niemand befüllt.
        * Seit der repariert ist, sind es zwei Knöpfe für dieselbe Sache,
        * zwanzig Punkte voneinander entfernt. Der obere ist der richtige: Er
        * fragt vorher nach, dieser tat es nicht.
        */}
      <View style={styles.headRow}>
        <Text style={styles.headText2}>{t("alert.hits.title")}</Text>
      </View>

      {/**
        * Eine Scroll-Fläche mit gedeckelter Höhe statt einer Liste: Es sind
        * höchstens fünfzig Einträge, und eine virtualisierte Liste in einem
        * Blatt, das selbst auf einer Wisch-Geste liegt, bringt zwei Gesten in
        * Konflikt, die sich nichts zu sagen haben.
        */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        // Kein Dehn-Effekt am Rand: Die Liste sitzt im Benachrichtigungs-Blatt,
        // das man zum Schließen wischt — Android dehnte sonst den Inhalt gegen
        // das fahrende Blatt (wie im Ticket-Blatt abgeschaltet).
        overScrollMode="never"
      >
        {hits.map((h) => (
          <Card key={h.id} hit={h} />
        ))}
      </ScrollView>
    </View>
  );
});

const styles = scaledStyles({
  wrap: { paddingHorizontal: GUTTER, paddingTop: SPACE.sm },
  headRow: { paddingBottom: SPACE.md },
  headText2: { fontSize: 13, fontWeight: "600", color: C.sub },
  scroll: { maxHeight: 320 },
  scrollContent: { gap: SPACE.sm },

  /**
   * DIESELBEN Maße wie `PriceAlertCard` — Zeichen für Zeichen.
   *
   * Beide zeigen dieselbe Strecke in derselben Form; stünden sie in zwei
   * Größen da, sähe es nach zwei verschiedenen Sachen aus. Wer hier etwas
   * ändert, ändert es dort mit.
   */
  /** Dieselbe Aufteilung und dieselben Zahlen wie `PriceAlertCard`. */
  card: { borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16 },
  /** Kurzes Abdunkeln statt Ripple — siehe die Begründung an der Karte. */
  cardPressed: { opacity: 0.7 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: SPACE.md },
  headText: { flex: 1, minWidth: 0 },
  route: { fontSize: 17, fontWeight: "700", color: C.text, lineHeight: 23 },
  meta: { fontSize: 14, fontWeight: "500", color: C.sub, marginTop: SPACE.xs + 2 },
  /** Zahl für Zahl das Herz-Feld der Alarm-Karte — siehe dort. */
  heart: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    marginTop: -2,
  },
  divider: { height: 1, backgroundColor: "#212123", marginVertical: 14 },
  /**
   * Maße und Abstände wie die Schalterzeile der Alarm-Karte: Feld, Zwölfer-Lücke,
   * Beschriftung mit `flex: 1`, rechts der Inhalt. Zwei Karten, die dieselbe
   * Sache in zwei Rastern zeigen, sehen nach einem Fehler aus.
   */
  factRow: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
  /** Dieselbe Fläche und Form wie auf der Alarm-Karte. */
  modeBox: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  /**
   * Das Datum nimmt den Platz ein, den auf der Alarm-Karte die Beschriftung
   * hat — `flex: 1` schiebt damit die Zahlen an die rechte Kante, genau dorthin,
   * wo dort der Schalter sitzt.
   */
  when: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: "500", color: C.sub },
  numbers: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
  pct: { fontSize: 15, fontWeight: "700" },
  price: { fontSize: 15, fontWeight: "700", color: C.text },
});
