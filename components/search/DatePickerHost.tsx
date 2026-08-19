/**
 * DatePickerHost — Root-Level Wrapper für den BinchDatePicker.
 *
 * BinchDatePicker ist IMMER gemountet (LocationPicker-Pattern): kein Cold-
 * Start beim ersten Open. Visibility wird via Store-State (`datePickerRequest`)
 * gesteuert; der Slide selbst läuft auf dem UI-Thread via SharedValues.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { BinchDatePicker } from "./BinchDatePicker";
import { subscribeDatePreload } from "@/lib/nav/pickerPreload";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";
import { SHEET_IN, SHEET_OUT } from "@/lib/nav/overlayCover";

/** Wie lange ein Vorlauf als „gehört zu diesem Öffnen" gilt. */
const PRELOAD_MAX_AGE_MS = 2000;

export function DatePickerHost() {
  const request = useSearchStore((s) => s.datePickerRequest);
  const closeDatePicker = useSearchStore((s) => s.closeDatePicker);
  const confirmDatePicker = useSearchStore((s) => s.confirmDatePicker);
  const t = useT();

  // Wenn der Picker gerade nicht offen ist, mounten wir den BinchDatePicker
  // TROTZDEM mit visible=false → er bleibt für die ganze Session im Tree,
  // slidet beim nächsten Open instant auf UI-Thread rein.
  /**
   * Zuletzt gezeigter Auftrag — gespeist vom echten Auftrag UND vom Vorbau aus
   * dem Berührungsfenster (siehe `pickerPreload`), in dieser Reihenfolge.
   *
   * Beim Datumswähler geht es nicht um Zeilen, sondern um das Startdatum: An
   * `initialDate` hängt die ausgewählte Zelle, an `minimumDate` die Sperre der
   * vergangenen Tage — und daran wiederum die Zeichenfunktion der Kalenderliste.
   * Ohne Auftrag stehen beide auf ihren Vorgabewerten, der echte Wert kam also
   * erst im Öffnungs-Commit an und ließ sämtliche gemounteten Wochenzeilen neu
   * rendern, genau im Anlauf der Bewegung.
   *
   * Das Festhalten nach dem Schließen hat denselben zweiten Nutzen wie beim
   * Ortspicker: Die Beschriftung fiel beim Zufahren sonst auf „Hinfahrt"
   * zurück, auch wenn gerade die Rückfahrt gewählt worden war.
   */
  const lastRef = useRef(request);
  if (request) lastRef.current = request;
  const [, forceShow] = useState(0);
  useEffect(
    () =>
      subscribeDatePreload((req) => {
        lastRef.current = req;
        setMounted(true);
        preloadedAtRef.current = Date.now();
        bumpSession();
        forceShow((n) => n + 1);
      }),
    [],
  );
  const shown = lastRef.current;

  /**
   * Die Sichtbarkeit erreicht das Blatt ein Bild SPÄTER als die Bewegung.
   *
   * Genau das macht das Such-Blatt anders, und es ist der letzte strukturelle
   * Unterschied: Dort schaltet ein Reanimated-Wert die Sichtbarkeit, hier ein
   * React-Prop. Ein Prop-Wechsel rendert den ganzen Wähler neu — und dieser
   * Durchgang fiel bisher in genau das Bild, in dem die Fahrt losläuft.
   *
   * Das Blatt startet seine Bewegung selbst, direkt aus dem Speicher (siehe
   * dort). Was hier noch ankommt, sind nur die Dinge, die React braucht:
   * Abfrage, Zurück-Taste, Zurücksetzen. Ein Bild Verzögerung ist dafür
   * unerheblich — für die Bewegung ist es der Unterschied.
   */
  /**
   * Ob der INHALT im Baum liegt — getrennt von der Sichtbarkeit.
   *
   * Dasselbe Muster, mit dem das Auth-Blatt weich geworden ist: Die Hülle samt
   * Bewegungswert bleibt dauerhaft, der schwere Inhalt aber nicht. Dauerhaft
   * gemountet wird er bei JEDER Vermessung des Wurzelbaums mitgemessen — und
   * die läuft unter `adjustResize` bei jeder Tastatur, also mitten in fremde
   * Fahrten hinein.
   *
   * Aufgebaut wird spätestens beim BERÜHREN des Feldes (der Vorlauf meldet sich
   * hier), meist aber schon im Leerlauf nach dem Start — siehe unten. Abgebaut
   * wird nicht mehr; im Bild der Fahrt passiert damit weder das eine noch das
   * andere.
   */
  const [mounted, setMounted] = useState(false);
  /**
   * EINMAL bauen, dann stehen lassen — und zwar schon im Leerlauf nach dem
   * Start.
   *
   * Zwei Fragen hängen daran, und beide sind vorher falsch beantwortet worden:
   *
   *  1. Wann bauen? Dauerhaft gemountet kostet jede Vermessung des Wurzelbaums
   *     mit (unter `adjustResize` also jede Tastatur). Erst beim Berühren zu
   *     bauen verlegt die Arbeit dagegen in die 80 bis 150ms zwischen Aufsetzen
   *     und Loslassen — gut, aber beim ALLERERSTEN Mal ist dieser Aufbau kalt
   *     und damit der teuerste. Genau deshalb fühlt sich das erste Öffnen
   *     anders an als jedes weitere.
   *
   *     Also: ein paar Sekunden nach dem Start, wenn nichts läuft. Dann ist er
   *     fertig, bevor ihn jemand braucht.
   *
   *  2. Wann wieder abbauen? Gar nicht. Ein Abbau nach jeder Ausfahrt hieße,
   *     dass JEDES Öffnen wieder aufbaut — der teure Fall würde zur Regel statt
   *     zur Ausnahme.
   */
  useEffect(() => {
    if (mounted) return;
    let id: ReturnType<typeof setTimeout>;
    /**
     * Und wirklich erst, wenn NICHTS fährt.
     *
     * Eine feste Wanduhr trifft irgendwann — womöglich mitten in eine Fahrt,
     * und dann committen beide schweren Bäume im selben Bild. Dieselbe Prüfung
     * benutzen der Anlauf der Übergabe-Textur und das Zurücksetzen des
     * Kalenders; hier fehlte sie.
     */
    const attempt = () => {
      if (isTransitionBusy()) {
        // Wie beim Zurücksetzen des Kalenders: Der Wiederversuch selbst ist nur
        // ein Zeitstempel-Vergleich und stört keine Bewegung.
        id = setTimeout(attempt, 300);
        return;
      }
      setMounted(true);
    };
    // Und versetzt zum Ortswähler (4200) — sonst committen beide schweren
    // Bäume im selben Bild, und das sieht man im Landingscreen als Hänger.
    /**
     * ERST NACH dem Startbild, nicht mittendrin.
     *
     * Der Startbildschirm läuft 3,5 Sekunden und blendet danach 420ms aus. Ein
     * Vorbau-Wecker bei 2,5s (und der Schwester-Wecker bei 3,4s) fiel damit
     * mitten in dessen Buchstaben-Animation und ihr Ausblenden — der schwerste
     * Baum der App committet also genau dort, wo das erste, was jemand von der
     * App sieht, jedes Bild braucht.
     *
     * Kosten hat das Warten keine: Wer ein Feld antippt, bevor der Wecker
     * fällt, baut es über den Vorlauf beim Berühren ohnehin sofort auf.
     */
    id = setTimeout(attempt, 5200);
    return () => clearTimeout(id);
  }, [mounted]);
  /**
   * Beim Öffnen NICHT noch einmal zählen.
   *
   * Der Vorlauf beim Berühren hat es längst getan. Ein zweiter Zähler-Schritt
   * fällt genau ins Startbild der Fahrt — und er reißt beide Merk-Schranken auf
   * (Wähler und Inhalt), also den teuersten Durchgang der Datei, mitten in die
   * Bewegung. Nachgezählt wird nur, wenn es gar keinen Vorlauf gab: aus der
   * Umgebungs-Karte, per Sprachbefehl oder Verknüpfung.
   */
  /**
   * Als ZEITSTEMPEL, nicht als Schalter.
   *
   * Ein Vorlauf entsteht beim Aufsetzen des Fingers — und der führt nicht
   * immer zu einem Öffnen: Wer stattdessen wischt, lässt den Schalter
   * gesetzt zurück. Der nächste Aufruf OHNE Vorlauf (Umgebungs-Karte,
   * Sprachbefehl, Verknüpfung) verbrauchte ihn dann und zählte nicht nach —
   * der Wähler kam mit der alten Eingabe samt Trefferliste hoch.
   *
   * Mit einer Frist erledigt sich das von selbst: Zwischen Aufsetzen und
   * Loslassen liegen Zehntelsekunden, alles darüber war kein Vorlauf für
   * dieses Öffnen.
   */
  const preloadedAtRef = useRef(0);
  useEffect(() => {
    if (request === null) return;
    setMounted(true);
    const fresh = Date.now() - preloadedAtRef.current < PRELOAD_MAX_AGE_MS;
    preloadedAtRef.current = 0;
    if (fresh) return;
    bumpSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  /**
   * Die Sitzungs-Kennung zählt beim BERÜHREN hoch, nicht beim Öffnen.
   *
   * Der Inhalt braucht ein Signal „neue Öffnung, übernimm die Vorgaben". Bisher
   * war das `visible` — und das kippt erst mit der Bewegung, also mitten in
   * ihrem zweiten Bild. Beim Datumswähler hängt daran die Memo-Schranke des
   * ganzen Kalenders: Der baute sich damit zuverlässig WÄHREND der Fahrt neu
   * auf. Genau das sind die verschluckten Bilder.
   *
   * Über den Vorlauf gezählt passiert dasselbe im Berührungsfenster, lange
   * davor.
   */
  const [session, setSession] = useState(0);
  const bumpSession = useCallback(() => setSession((n) => n + 1), []);

  /**
   * Sichtbarkeit erst NACH der Bewegung.
   *
   * Sie war ein Bild verzögert, damit der Commit nicht ins Startbild fällt —
   * nur lag er dann im zweiten. Alles, was daran hängt, hat Zeit: die
   * Zurück-Taste, die Abfrage, die Berührungsdurchlässigkeit. Keines davon
   * braucht während der Fahrt zu stimmen, und so rendert der Baum in diesen
   * 300ms überhaupt nicht mehr.
   */
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const open = request !== null;
    const id = setTimeout(
      () => setVisible(open),
      // +80, nicht +20: Die Kurve ENDET bei `duration`, das letzte Bild wird
      // aber erst danach gezeichnet. Mit 20ms Abstand fiele der Commit noch in
      // dieses Bild — dieselbe Marge, die `markSheetMoving` für die Anmeldung
      // benutzt.
      (open ? SHEET_IN.duration : SHEET_OUT.duration) + 80,
    );
    return () => clearTimeout(id);
  }, [request]);
  const fieldLabel = useMemo(
    () =>
      shown?.field === "return"
        ? t("search.return")
        : t("search.departure"),
    [shown?.field, t],
  );

  /**
   * STABIL — sonst ist die Memo-Schranke des Kalenders wirkungslos.
   *
   * Der Rückruf stand als Pfeilfunktion direkt im Element und war damit bei
   * jedem Durchgang neu. `DatePickerContent` ist ausdrücklich gemerkt, mit dem
   * Hinweis „die Eigenschaften sind alle stabil" — diese eine war es nicht, und
   * sie hebelt die ganze Schranke aus. Der Wirt rendert inzwischen dreimal rund
   * um eine Öffnung (Vorlauf beim Aufsetzen, Aufbau-Schalter, verzögerte
   * Sichtbarkeit), einer davon liegt im zweiten Bild der Fahrt.
   */
  const onConfirmDate = useCallback(
    ({ year, month, day, hour, minute }: {
      year: number; month: number; day: number; hour: number; minute: number;
    }) => {
      confirmDatePicker(new Date(year, month, day, hour, minute, 0, 0));
    },
    [confirmDatePicker],
  );

  return (
    <BinchDatePicker
      visible={visible}
      mounted={mounted}
      session={session}
      onClose={closeDatePicker}
      minimumDate={shown?.minimumDate ?? undefined}
      initialDate={shown?.initialDate ?? null}
      fieldLabel={fieldLabel}
      onConfirmDate={onConfirmDate}
    />
  );
}
