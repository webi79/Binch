/**
 * LocationPickerHost — am Root-Layout gemountet damit der LocationPicker
 * vom App-Start an warm ist (kein Cold-Start beim ersten Open im
 * SearchHero). Gleicher Pattern wie DatePickerHost.
 */
import { useEffect, useRef, useState } from "react";
import { useSearchStore } from "@/stores/searchStore";
import { LocationPicker } from "./LocationPicker";
import { subscribeLocationPreload } from "@/lib/nav/pickerPreload";
import { PICKER_OUT } from "@/lib/nav/overlayCover";

export function LocationPickerHost() {
  const request = useSearchStore((s) => s.locationPickerRequest);

  /**
   * Der zuletzt gestellte Auftrag wird festgehalten — sonst wechselt der Inhalt
   * MITTEN im Hinausfahren.
   *
   * Beim Schließen fällt `locationPickerRequest` sofort auf null, das Blatt
   * fährt danach aber noch hinaus. Alle Angaben unten fielen in dieser Zeit auf
   * ihre Vorgabewerte zurück — und `field` steht dort auf „from". Wer also das
   * ZIEL ausgewählt hatte, sah beim Zufahren plötzlich die Überschrift des
   * Startfeldes („Wo soll es losgehen?"). Es sah aus, als schlösse sich ein ganz
   * anderer Bildschirm.
   *
   * Dieselbe Lösung wie beim Detail-Blatt und der Etappen-Ansicht: den letzten
   * Stand halten, solange die Bewegung läuft. Sichtbar bleibt damit bis zum
   * Schluss das, was der Nutzer geöffnet hatte.
   */
  const lastRef = useRef(request);
  if (request) lastRef.current = request;
  /**
   * Der letzte Auftrag bleibt stehen — bewusst, und das ist die Korrektur einer
   * Korrektur.
   *
   * Ich hatte ihn nach der Ausfahrt geleert, weil er sonst rund 90 Ansichten und
   * 30 Speicher-Abonnements für ein geschlossenes Blatt hält. Das stimmt, ist
   * aber der falsche Tausch: Beim nächsten Öffnen entsteht der ganze Baum dann
   * NEU, und zwar in genau dem Bild, in dem die Bewegung anläuft. Auf Fabric
   * hängt Mount-Arbeit auf demselben Strang wie die Kurve — das Blatt fuhr
   * danach sichtbar ruckelig herein.
   *
   * Der Bericht, der das Halten bemängelte, hatte es selbst als „reine Speicher-
   * und Fan-out-Kosten, kein Bild-Reißer" eingestuft. Ich habe daraus trotzdem
   * eine Änderung gemacht und damit Speicherplatz gegen Bilder getauscht. Genau
   * dafür hält diese App ihre schweren Bäume dauerhaft gemountet.
   */
  /**
   * Der Vorbau aus dem Berührungsfenster schreibt in DIESELBE Ablage — siehe
   * `pickerPreload`.
   *
   * Nicht als zweite, vorrangige Quelle: Der Ortspicker wird auch von der
   * Umgebungs-Suche geöffnet, also ohne vorherige Berührung im Such-Hero. Ein
   * eigener Vorbau-Zustand hätte dort einen veralteten Auftrag aus dem
   * Such-Hero gehalten und ihn beim Zufahren nach vorn gelassen — exakt der
   * Fehler, gegen den `lastRef` oben geschrieben ist.
   *
   * In einer gemeinsamen Ablage entscheidet schlicht, wer zuletzt geschrieben
   * hat: Ein echter Auftrag überschreibt sie im Render, eine neue Berührung
   * danach ebenfalls. Beides ist genau die gewünschte Reihenfolge.
   *
   * Der Vorbau zählt ausdrücklich nicht als „offen": `visible` unten hängt
   * weiter allein an `request`.
   */
  const [, forceShow] = useState(0);
  useEffect(
    () =>
      subscribeLocationPreload((req) => {
        lastRef.current = req;
        setMounted(true);
        forceShow((n) => n + 1);
      }),
    [],
  );

  const shown = request ?? lastRef.current;
  const closeLocationPicker = useSearchStore((s) => s.closeLocationPicker);
  const confirmLocationPicker = useSearchStore((s) => s.confirmLocationPicker);

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

  return (
    <LocationPicker
      visible={visible}
      mounted={mounted}
      onClose={closeLocationPicker}
      onSelect={confirmLocationPicker}
      field={shown?.field ?? "from"}
      mode={shown?.mode ?? "ALL"}
      suggested={shown?.suggested ?? []}
      title={shown?.title}
      leadingLabel={shown?.leadingLabel}
      placeholderKey={shown?.placeholderKey ?? "search.location.placeholder"}
      onCurrentLocation={shown?.onCurrentLocation}
    />
  );
}
