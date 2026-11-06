import { memo, useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Bus, Heart, Plane, Ship, Train, type LucideIcon } from "lucide-react-native";
import { haptic } from "@/lib/haptics";
import { showAlert } from "@/lib/alert";
import { useRouteMeta } from "@/lib/format/routeMeta";
import { useT } from "@/lib/i18n/useT";
import { deleteAlertOnServer, setAlertActiveOnServer } from "@/lib/notifications/alertToggle";
import { usePalette } from "@/lib/theme/appBg";
import { SPACE } from "@/lib/theme/spacing";
import { scaledStyles } from "@/lib/ui/compact";
import { BinchSwitch } from "@/components/ui/BinchSwitch";
import { ClearSearchHistoryAlert } from "@/components/ui/ClearSearchHistoryAlert";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useSearchStore } from "@/stores/searchStore";
import type { PriceAlert } from "@/types/saved";
import type { TravelMode } from "@/types/search";

/**
 * Die Karte eines Preis-Alarms — dort, wo er hingehört.
 *
 * Vorher lagen die Alarme unter der GLOCKE, und das war falsch herum: Die
 * Glocke steht für Meldungen, ein gesetzter Alarm ist aber noch keine — er ist
 * eine stehende Beobachtung einer Strecke. Dorthin, wo man seine Reisen
 * wiederfindet, gehört er; unter die Glocke gehört erst, was er AUSGELÖST hat.
 *
 * AUFBAU: Strecke, Eckdaten, Trennlinie, Schalter. Der Schalter unten ist
 * derselbe wie in den Einstellungen und im Alarm-Blatt (`BinchSwitch`) — drei
 * Kopien eines Bedienteils waren drei Stellen, an denen sie auseinanderliefen.
 */


/**
 * Das Symbol je Verkehrsmittel — dieselbe Zuordnung, die auch die Reisekarte
 * und der Kopf der Ergebnisliste führen. Eine eigene wäre eine zweite Wahrheit
 * darüber, wie ein Zug aussieht.
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
  /** Das Rot der gemerkten Reise — derselbe Wert wie in `ResultCard`. */
  heart: "#FF3B5C",
};

export const PriceAlertCard = memo(function PriceAlertCard({ alert }: { alert: PriceAlert }) {
  const t = useT();
  const palette = usePalette();
  const { metaLine, routeLine } = useRouteMeta();
  const setPriceAlertActive = useSearchStore((s) => s.setPriceAlertActive);
  const removePriceAlert = useSearchStore((s) => s.removePriceAlert);
  /**
   * Läuft gerade ein Server-Aufruf? Als Zustand DIESER Karte, nicht global —
   * sonst legte sich der Schleier über alle Karten, während nur eine arbeitet.
   */
  const [busy, setBusy] = useState(false);
  /**
   * Steht die Rückfrage vor dem Löschen offen?
   *
   * Wie `busy` ein Zustand DIESER Karte: In der Liste stehen beliebig viele
   * Alarme, und ein geteilter Zustand weiter oben müsste zusätzlich mitführen,
   * WELCHER gemeint ist — eine zweite Wahrheit über dieselbe Sache.
   */
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Fehlt das Feld, gilt der Alarm als aktiv — siehe `PriceAlert.active`.
  const on = alert.active !== false;
  const Icon = MODE_ICON[alert.mode] ?? Train;

  const toggle = useCallback(() => {
    if (busy) return;
    haptic("button");
    const next = !on;
    /**
     * Der Schalter springt SOFORT — und die Karte dimmt nicht mehr.
     *
     * Vorher lief es andersherum: erst der Server, dann die Anzeige, und
     * währenddessen lag ein halbdurchsichtiger Schleier über der ganzen Karte.
     * Bei einer Antwortzeit von zweihundert Millisekunden sah das nicht nach
     * Arbeit aus, sondern nach einem Aufblitzen bei jeder Berührung — genau das
     * war die Beanstandung.
     *
     * Vorweggenommen wird die Anzeige nur, WEIL sie zurücknehmbar ist:
     * Scheitert der Aufruf, springt der Schalter zurück und es kommt eine
     * Meldung dazu. Ein vorweggenommener Zustand ohne Rücknahme wäre eine Lüge;
     * mit Rücknahme ist er die ehrlichste schnelle Antwort, die es gibt.
     */
    setPriceAlertActive(alert.id, next);
    setBusy(true);
    void (async () => {
      const res = await setAlertActiveOnServer(alert, next);
      setBusy(false);
      if (res.ok) {
        /**
         * Eine NEUE Server-Kennung kommt nur, wenn der Alarm dort neu angelegt
         * werden musste (seine Zeile war weg) — ohne sie ließe er sich später
         * nicht mehr löschen. Der Regelfall ist heute die Pause, und die gibt
         * keine zurück: Die Zeile bleibt ja dieselbe.
         *
         * `next` statt eines festen `true`: Der Zustand steht schon oben, hier
         * wird nur die Kennung nachgetragen. Ein hartes `true` wäre eine zweite
         * Wahrheit über den Schalter — und eine, die ihn umlegte.
         */
        if (res.serverId) setPriceAlertActive(alert.id, next, res.serverId);
        return;
      }
      /**
       * Zurücknehmen — die Server-Kennung ausdrücklich MIT.
       *
       * Seit das Abschalten nur pausiert, bleibt sie ohnehin stehen; nötig ist
       * der zweite Wert trotzdem, denn der Fehlschlag kann auch das
       * EINSCHALTEN treffen. Dann wurde vielleicht schon eine neue Zeile
       * angelegt und wieder verworfen, und die Karte muss auf dem Stand landen,
       * den sie vor dem Tipp hatte.
       *
       * `alert.serverId` ist hier der Wert VOR dem Umschalten — die
       * Eigenschaft stammt aus dem Durchgang, in dem noch nichts geändert war.
       */
      setPriceAlertActive(alert.id, on, alert.serverId);
      /**
       * Die Meldung nennt, was NICHT passiert ist — und das ist seit der Pause
       * etwas anderes als „gelöscht": Hier stand „Alarm konnte nicht gelöscht
       * werden", obwohl niemand löschen wollte. Wer den Schalter umlegt, will
       * ihn stummschalten; scheitert das, muss die Meldung sagen, dass er
       * weitermeldet.
       *
       * Ausgeschrieben statt zusammengesetzt: Die Schlüssel sind ein Typ, ein
       * zusammengebauter wäre nur noch eine Zeichenkette — genau die Stelle, an
       * der ein Tippfehler später als leerer Text auf dem Gerät landet.
       */
      if (res.reason === "nopush") {
        showAlert(t("alert.nopush.title"), t("alert.nopush.body"));
      } else if (next) {
        showAlert(t("alert.resume.failed.title"), t("alert.resume.failed.body"));
      } else {
        showAlert(t("alert.pause.failed.title"), t("alert.pause.failed.body"));
      }
    })();
  }, [alert, busy, on, setPriceAlertActive, t]);

  /**
   * Nur die RÜCKFRAGE öffnen — hier wird noch nichts gelöscht.
   *
   * Der Alarm ist das einzige Gemerkte, das auch auf dem SERVER liegt: Ein
   * Fehlgriff nimmt nicht bloß eine Karte aus der Liste, er kündigt eine
   * laufende Beobachtung. Wiederherstellen ließe sie sich nur, indem man die
   * Suche noch einmal aufsetzt.
   */
  const askRemove = useCallback(() => {
    // Läuft gerade ein Server-Aufruf (Schalter), gar nicht erst fragen — die
    // Antwort käme auf einen Stand, den die Frage noch nicht kennt.
    if (busy) return;
    haptic("button");
    setConfirmOpen(true);
  }, [busy]);

  /**
   * Der Löschweg selbst — das EINZIGE, was einen Alarm wirklich beendet.
   *
   * Der Schalter daneben pausiert nur; wer die Beobachtung loswerden will,
   * kommt über das Herz und diese Rückfrage. Sie sitzt DAVOR, nicht mittendrin:
   * Server-Löschung und lokales Entfernen sind ein Ablauf, in den sich kein
   * Dialog schieben darf.
   */
  const remove = useCallback(() => {
    if (busy) return;
    setConfirmOpen(false);
    setBusy(true);
    void (async () => {
      /**
       * Erst auf dem Server löschen, dann die Karte wegnehmen — und zwar IMMER.
       *
       * Hier stand `on ? … : { ok: true }`: Ein bereits abgeschalteter Alarm
       * wurde ohne jeden Server-Aufruf aus der Liste geworfen. Das ging auf,
       * solange „aus" schon gelöscht hieß. Seit es eine Pause ist, war es die
       * schlimmste Sorte Fehler — die Karte verschwand auch OHNE Verbindung,
       * und der Alarm blieb in der Datenbank zurück, ohne dass ihn danach noch
       * irgendetwas erreichen konnte. Genau so wurde es gemeldet.
       *
       * Scheitert der Aufruf, bleibt die Karte stehen. Ein Löschen, das nur so
       * tut, ist schlimmer als eines, das scheitert: Beim Scheitern kann man es
       * erneut versuchen.
       */
      const res = await deleteAlertOnServer(alert);
      setBusy(false);
      if (!res.ok) {
        /**
         * Hier IMMER die Lösch-Meldung, auch wenn keine Push-Kennung zu holen
         * war.
         *
         * Die Erlaubnis-Meldung schickt in die Systemeinstellungen — beim
         * Löschen zeigte sie auf die falsche Ursache: Ohne Netz kommt man an
         * die Kennung ebenfalls nicht heran, und dort ist nichts einzustellen.
         * Was der Nutzer wissen muss, ist in beiden Fällen dasselbe: Der Alarm
         * liegt noch da, und ein zweiter Versuch lohnt sich.
         */
        showAlert(t("alert.delete.failed.title"), t("alert.delete.failed.body"));
        return;
      }
      removePriceAlert(alert.id);
    })();
    // `on` gehört hier NICHT mehr hinein — gelöscht wird unabhängig davon, ob
    // der Alarm gerade läuft oder pausiert ist.
  }, [alert, busy, removePriceAlert, t]);

  return (
    /**
     * Der Schatten liegt auf einer EIGENEN Hülle, nicht auf der Karte.
     *
     * Zeichen für Zeichen derselbe wie an der Reisekarte — eine Schicht,
     * `0px 8px 20px -6px` bei 55 % Deckung. Warum eine eigene Hülle: Die Karte
     * rundet ihre Ecken, und wer dafür `overflow: "hidden"` setzt, schneidet
     * einen Außenschatten mit weg. Dieselbe Aufteilung wie dort.
     */
    <View style={styles.shadow}>
      <View style={[styles.card, { backgroundColor: palette.s2 }]}>
        <View style={styles.head}>
          <View style={styles.headText}>
            <Text style={styles.route} numberOfLines={2}>
              {routeLine(alert.originLabel, alert.destLabel)}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {metaLine({
                departDate: alert.departDate,
                returnDate: alert.returnDate,
                passengers: alert.passengers,
                travelClassKey: alert.travelClass,
              })}
            </Text>
          </View>
          {/**
            * Das HERZ, nicht der Papierkorb — und das ist mehr als ein Symbol.
            *
            * Ein gefülltes Herz sagt „gemerkt", und ein Tipp darauf nimmt die
            * Merkung zurück — dieselbe Geste, die in der ganzen App etwas aus
            * „Gespeichert" entfernt. Der Alarm auf dem Server geht dabei mit,
            * und GENAU deshalb fragt es hier trotzdem nach: Dass die Geste
            * harmlos aussieht, macht sie nicht rücknehmbar.
            *
            * Größe und Farbe kommen von der Reisekarte: 18 Punkte, `#FF3B5C`
            * gefüllt. Ein zweites Rot oder eine zweite Größe für dasselbe
            * Zeichen wären der Unterschied, den man sieht, ohne ihn benennen
            * zu können.
            *
            * `RippleTouch` OHNE `borderless`: Damit setzt es `overflow:
            * "hidden"`, und der Ripple wird auf den Kreis beschnitten statt
            * rechteckig über ihn hinauszulaufen.
            */}
          <RippleTouch
            onPress={askRemove}
            hitSlop={8}
            accessibilityLabel={t("common.delete")}
            style={styles.heart}
          >
            <Heart size={18} color={C.heart} fill={C.heart} />
          </RippleTouch>
        </View>

        {/* Dieselbe Linie wie in der Reisekarte: ein Punkt hoch, Rahmenfarbe,
            vierzehn Punkte Abstand nach oben und unten. Eine Haarlinie mit
            zehn Prozent Deckung stand hier zuvor — auf dem Gerät war davon
            nichts zu sehen. */}
        <View style={styles.divider} />

        {/* Die ganze Zeile schaltet, nicht nur der Schalter — siehe
            `BinchSwitch` und die gleichlautende Zeile im Alarm-Blatt. */}
        <Pressable
          onPress={toggle}
          accessibilityRole="switch"
          accessibilityState={{ checked: on }}
          accessibilityLabel={t("alert.card.toggle")}
          style={styles.switchRow}
        >
          {/* Das Verkehrsmittel VOR der Beschriftung, in derselben Fläche wie
              das Herz darüber — abgerundetes Quadrat statt Kreis, damit die
              beiden nicht wie zwei Knöpfe aussehen: Das Herz ist eines, dies
              hier ist eine Auskunft. */}
          <View style={styles.modeBox}>
            <Icon size={16} color={C.text} strokeWidth={2} />
          </View>
          <Text style={styles.switchLabel}>{t("alert.card.toggle")}</Text>
          <BinchSwitch value={on} readOnly />
        </Pressable>
      </View>

      {/* Derselbe Dialog wie beim Leeren des Suchverlaufs und der Meldungen —
          bewusst kein eigener: Zwei Karten für dieselbe Frage liefen in diesem
          Projekt schon zweimal auseinander. Der Text nennt den Server, weil
          genau das der Unterschied zu jedem anderen Gemerkten ist. */}
      <ClearSearchHistoryAlert
        visible={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={remove}
        title={t("saved.alert.delete.title")}
        message={t("saved.alert.delete.body").replace(
          "{route}",
          routeLine(alert.originLabel, alert.destLabel),
        )}
        confirmLabel={t("saved.alert.delete.confirm")}
        cancelLabel={t("common.cancel")}
      />
    </View>
  );
});

const styles = scaledStyles({
  /**
   * Schatten und Karte sind GETRENNT — siehe oben im Aufbau. Der Radius steht
   * auf beiden, damit der Schatten der Kontur der Karte folgt.
   */
  shadow: {
    borderRadius: 20,
    boxShadow: "0px 8px 20px -6px rgba(0, 0, 0, 0.55)",
  },
  /**
   * Polster und Rundung kommen von der REISEKARTE (`ResultCard`), Zahl für
   * Zahl: 20 Rundung, 14 oben und unten, 16 links und rechts.
   *
   * Diese Karte steht in derselben Liste wie jene. Zwei Karten übereinander mit
   * verschiedenem Polster sehen nicht nach zwei Sorten aus, sondern nach einem
   * Fehler — und zwar nach einem, den man sieht, ohne ihn benennen zu können.
   *
   * Das Polster steht auf der KARTE, nicht auf ihren beiden Blöcken. Damit ist
   * der Abstand zu allen vier Rändern an einer Stelle festgelegt und kann nicht
   * auseinanderlaufen; die Trennlinie bringt ihren eigenen Abstand mit, genau
   * wie dort.
   */
  card: { borderRadius: 20, paddingVertical: 16, paddingHorizontal: 16 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: SPACE.md },
  headText: { flex: 1, minWidth: 0 },
  route: { fontSize: 17, fontWeight: "700", color: C.text, lineHeight: 23 },
  meta: { fontSize: 14, fontWeight: "500", color: C.sub, marginTop: SPACE.sm },
  /**
   * Das runde Feld ist so hoch wie die Titelzeile und liegt deshalb auf DEREN
   * Höhe, nicht auf der Mitte des ganzen Kopfes: Bei zwei Zeilen Strecke bliebe
   * es sonst irgendwo dazwischen hängen. `head` richtet seine Kinder oben aus,
   * genau dafür.
   *
   * Die Fläche ist eine HELLE mit geringer Deckung, keine Flächenstufe: Die
   * Stufen dieses Themas liegen vier bis sechs Prozent auseinander und sind auf
   * OLED-Schwarz in beide Richtungen unsichtbar — zweimal überprüft, zweimal
   * bestätigt.
   */
  heart: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    marginTop: -2,
  },
  /** Zeichen für Zeichen die Linie der Reisekarte. */
  divider: { height: 1, backgroundColor: "#212123", marginVertical: 16 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
  /**
   * Dieselbe Fläche wie das Feld des Herzens (`rgba(255,255,255,0.08)`), nur
   * kleiner und als abgerundetes Quadrat. Die Größe folgt der Zeile: Ein Kasten
   * so hoch wie der Schalter daneben (30) machte die Zeile zur Werkzeugleiste;
   * 30 zu 24 hält die Auskunft kleiner als das Bedienteil.
   */
  modeBox: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  switchLabel: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: "600", color: C.text },
});
