/**
 * DatePickerHost — Root-Level Wrapper für den BinchDatePicker.
 *
 * BinchDatePicker ist IMMER gemountet (LocationPicker-Pattern): kein Cold-
 * Start beim ersten Open. Visibility wird via Store-State (`datePickerRequest`)
 * gesteuert; der Slide selbst läuft auf dem UI-Thread via SharedValues.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { BinchDatePicker } from "./BinchDatePicker";
import { subscribeDatePreload } from "@/lib/nav/pickerPreload";
import { PICKER_OUT } from "@/lib/nav/overlayCover";

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
   * Aufgebaut wird beim BERÜHREN des Feldes (der Vorlauf meldet sich hier),
   * also lange vor der Bewegung; abgebaut erst, wenn die Ausfahrt durch ist.
   * Im Bild der Fahrt passiert damit weder das eine noch das andere.
   */
  const [mounted, setMounted] = useState(false);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (unmountTimer.current) {
      clearTimeout(unmountTimer.current);
      unmountTimer.current = null;
    }
    if (request !== null) {
      setMounted(true);
      return;
    }
    unmountTimer.current = setTimeout(() => {
      unmountTimer.current = null;
      setMounted(false);
    }, PICKER_OUT.duration + 120);
    return () => {
      if (unmountTimer.current) clearTimeout(unmountTimer.current);
    };
  }, [request]);

  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(request !== null));
    return () => cancelAnimationFrame(id);
  }, [request]);
  const fieldLabel = useMemo(
    () =>
      shown?.field === "return"
        ? t("search.return")
        : t("search.departure"),
    [shown?.field, t],
  );

  return (
    <BinchDatePicker
      visible={visible}
      mounted={mounted}
      onClose={closeDatePicker}
      minimumDate={shown?.minimumDate ?? undefined}
      initialDate={shown?.initialDate ?? null}
      fieldLabel={fieldLabel}
      onConfirmDate={({ year, month, day, hour, minute }) => {
        const picked = new Date(year, month, day, hour, minute, 0, 0);
        confirmDatePicker(picked);
      }}
    />
  );
}
