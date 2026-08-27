import { useEffect, useMemo, useState } from "react";
import { useSearchStore } from "@/stores/searchStore";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";
import { AssistantScreen } from "./AssistantScreen";

/**
 * Hängt Bo ins Wurzel-Layout — und zwar NACH der Tab-Leiste.
 *
 * Genau darum geht es: Die Zeichen-Reihenfolge im Wurzel-Layout entscheidet,
 * was über was liegt. Als Route lag Bo im `<Stack>`, und der steht vor der
 * Leiste — er fuhr also darunter durch, und die Leiste musste ausgeblendet
 * werden, damit es nicht seltsam aussah. Beim Push von rechts fiel genau das
 * auf: Sie verschwand, statt überfahren zu werden.
 *
 * Ergebnisliste und Detail-Blatt hatten dieses Problem nie — sie stehen seit
 * jeher nach der Leiste. Bo steht jetzt dort, wo er hingehört.
 */

/**
 * Wann der Leerlauf-Aufbau versucht wird — und WARUM Bo zuerst drankommt.
 *
 * Hinter dem Startbild (3,5s plus 420ms Ausblenden), aber VOR den beiden
 * Wählern. Diese Reihenfolge war umgekehrt, und das war falsch herum gedacht:
 * Bo stand als Letzter bei 6400, die Wähler bei 4200 und 5200.
 *
 * Erreichbar sind die drei aber völlig verschieden. Bo hängt an der Suchleiste
 * — sie steht auf dem Landingscreen, sichtbar, ab dem ersten Bild nach dem
 * Startbild. Die Wähler hängen an Feldern INNERHALB des Such-Bildschirms, den
 * man erst öffnen muss; bis dorthin vergehen ein Tipp und eine Fahrt.
 *
 * Wer also gleich nach dem Startbild auf die Suchleiste tippt — und das ist der
 * naheliegendste erste Griff überhaupt —, traf Bo über zwei Sekunden lang KALT
 * an und baute den schwersten Baum der App im Tipp-Bild auf. Die Wähler waren
 * derweil längst fertig, obwohl sie noch niemand brauchen konnte.
 *
 * Jetzt zuerst Bo, dann die Wähler (5400/6400). Näher an den Start geht nicht:
 * Während des Startbilds läuft dessen eigene Buchstaben-Animation, und ein
 * Commit dieser Größe mittendrin wäre genau dort zu sehen, wo man die App zum
 * ersten Mal sieht.
 */
const IDLE_BUILD_MS = 4200;



export function AssistantHost() {
  const open = useSearchStore((s) => s.assistantOpen);
  /**
   * Auch mounten, wenn nur VORBEREITET wurde (Finger auf der Suchleiste).
   */
  const preload = useSearchStore((s) => s.assistantPreload);

  /**
   * EINMAL bauen, dann nie wieder abbauen — wie das Such-Blatt.
   *
   * Vorher fuhr dieser Wirt ein Karussell: abbauen nach dem Schließen (mit
   * Karenz), wieder aufbauen nach einer Frist, beides zusätzlich auf eine
   * Bewegungs-Lücke wartend. Das erzeugte ein KALTES FENSTER von rund
   * anderthalb Sekunden nach jedem Schließen. Wer darin die Suchleiste antippte,
   * baute in den 80 bis 150ms des Fingers auf: rund achtzig native Ansichten,
   * einen Yoga-Durchgang, fünfzehn Reanimated-Anmeldungen — von denen jede die
   * sortierte Reihenfolge ALLER Zuordnungen der App verwirft — und die
   * Erstrasterung von Bos SVG. Das passt dort nicht hinein, und es ist der
   * Grund, warum es auch bei LEEREM Verlauf ruckelte: Der leere Verlauf ändert
   * daran nichts.
   *
   * Das Such-Blatt kennt dieses Fenster nicht — es hängt seit dem Start
   * dauerhaft im Wurzel-Layout und wird nur verschoben. Bo macht es jetzt
   * genauso.
   *
   * Der Abbau kostete außerdem selbst: Er ist der teuerste Commit dieses
   * Bildschirms, und er fiel in den Nachklang der Ausfahrt. Beides fällt weg.
   *
   * Was am Abbau hing — eine laufende Antwort abbrechen und den angefangenen
   * Text retten —, erledigt jetzt der Schließ-Pfad (`closeScreen`). Die
   * Abbau-Fassung bleibt als Netz für den Fall stehen, dass der Baum doch
   * einmal verschwindet.
   *
   * NICHT ab dem ersten Bild: Während des Startbilds läuft dessen eigene
   * Buchstaben-Animation, und ein Commit dieser Größe wäre genau dort zu sehen,
   * wo man die App zum ersten Mal sieht. Deshalb einmal im Leerlauf, hinter dem
   * Startbild — und wer vorher tippt, bekommt ihn sofort.
   */
  const [built, setBuilt] = useState(false);
  useEffect(() => {
    if (built) return;
    if (open || preload) {
      setBuilt(true);
      return;
    }
    let id: ReturnType<typeof setTimeout>;
    const attempt = () => {
      if (isTransitionBusy()) {
        // Der Wiederversuch ist nur ein Zeitstempel-Vergleich und stört keine
        // Bewegung.
        id = setTimeout(attempt, 300);
        return;
      }
      setBuilt(true);
    };
    id = setTimeout(attempt, IDLE_BUILD_MS);
    return () => clearTimeout(id);
  }, [built, open, preload]);

  /**
   * Das Element EINMAL bauen und festhalten.
   *
   * Dieser Wirt hängt an zwei Store-Feldern und rendert deshalb bei jedem
   * Öffnen und jedem Schließen neu. `<AssistantScreen />` frisch im `return`
   * heißt: ein neues Element, also ein erzwungener Neu-Durchlauf des größten
   * Baums der App — und zwar genau im Berührungs-Bild vor der Einfahrt und im
   * Nachklang der Ausfahrt. Bo braucht diesen Anstoß von oben nicht: Er hängt
   * mit eigenen Abonnements am selben Speicher und rendert von sich aus, wenn
   * sich für ihn etwas ändert.
   *
   * Der Aufbau bleibt an `built` gebunden — das Element wird erst gelesen, wenn
   * es so weit ist, und `useMemo` steht VOR dem Ausstieg (Hook-Reihenfolge).
   */
  const screen = useMemo(() => <AssistantScreen />, []);

  if (!built) return null;
  return screen;
}
