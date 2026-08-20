import { useEffect, useRef, useState } from "react";
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
 * Wann der Leerlauf-Aufbau versucht wird.
 *
 * Hinter dem Startbild (3,5s plus 420ms Ausblenden) UND hinter den beiden
 * Wählern (4200 und 5200), damit nicht drei schwere Bäume kurz hintereinander
 * committen. Bo ist der schwerste von allen und kommt deshalb zuletzt.
 */
const IDLE_BUILD_MS = 6400;

/**
 * Wie lange der Baum nach dem Schließen noch stehen bleibt.
 *
 * Der Abbau ist der teuerste Commit dieses Bildschirms — er nimmt jede
 * gemountete Nachrichten-Zeile mit, und jede bringt zwei Reanimated-Zuordnungen
 * mit, deren Entfernen die sortierte Reihenfolge ALLER Zuordnungen der App
 * verwirft. Er wächst also mit dem Verlauf.
 *
 * Ausgelöst wird er vom Wecker in `closeScreen`, und der steht 120ms hinter dem
 * Kurvenende — also mitten im Nachklang: Der Parallax des Landingscreens ist
 * gerade zur Ruhe gekommen, das Auge hängt noch an der Bewegung, und die Finger
 * sind schon wieder auf der Fläche. Genau dort fällt ein Ruckler auf, obwohl er
 * technisch nach der Fahrt liegt.
 *
 * Die Karenz schiebt ihn klar dahinter. Zu sehen ist von ihr nichts: Bo steht zu
 * diesem Zeitpunkt längst außerhalb des Bildes. Und wer in dieser Zeit erneut
 * öffnet, trifft den Baum sogar noch fertig an — das Zurücknehmen des
 * abgebrochenen Schließens erledigt der Bildschirm selbst (siehe
 * `assistantOpenSeq`).
 */
const UNMOUNT_GRACE_MS = 300;

export function AssistantHost() {
  const open = useSearchStore((s) => s.assistantOpen);
  /**
   * Auch mounten, wenn nur VORBEREITET wurde.
   *
   * Der Bildschirm steht dann geparkt eine volle Breite rechts neben dem Bild
   * — zu sehen ist nichts. Gewonnen ist alles: Beim Loslassen muss die Fahrt
   * nicht mehr gegen den Aufbau von 3500 Zeilen, Bos SVG, der Liste und der
   * Eingabeleiste anlaufen, sondern verschiebt einen fertigen Baum.
   */
  const preload = useSearchStore((s) => s.assistantPreload);

  /**
   * Und der Aufbau passiert von selbst im LEERLAUF, nicht erst beim Berühren.
   *
   * Das ist der Unterschied zwischen „beim ersten Mal hakt es, danach geht es"
   * und „es geht immer". Der Vorlauf beim Aufsetzen des Fingers hilft nur, wenn
   * der Aufbau in die 80 bis 150ms zwischen Aufsetzen und Loslassen passt — der
   * schwerste Baum der App tut das beim ALLERERSTEN Mal nicht. Danach ist alles
   * warm (Worklets übersetzt, native Ansichtstypen bekannt, Bilder dekodiert),
   * und deshalb fühlt sich jedes weitere Öffnen sauber an.
   *
   * Beide Wähler machen es seit Längerem genauso, mit derselben Bedingung:
   * wirklich nur, wenn gerade NICHTS fährt. Eine feste Wanduhr trifft sonst
   * irgendwann mitten in eine Bewegung, und dann committen zwei schwere Bäume
   * im selben Bild.
   */
  useEffect(() => {
    if (open || preload) return;
    let id: ReturnType<typeof setTimeout>;
    const attempt = () => {
      if (isTransitionBusy()) {
        // Der Wiederversuch selbst ist nur ein Zeitstempel-Vergleich und stört
        // keine Bewegung.
        id = setTimeout(attempt, 300);
        return;
      }
      useSearchStore.getState().preloadAssistant();
    };
    id = setTimeout(attempt, IDLE_BUILD_MS);
    return () => clearTimeout(id);
  }, [open, preload]);

  /**
   * Der Abbau kommt mit Karenz — aber nur, wenn wirklich etwas dastand.
   *
   * Ohne den Merker liefe die Karenz auch beim allerersten Durchlauf an und
   * würde Bo beim App-Start für 300ms mounten. Das ist das Gegenteil von dem,
   * was hier gewollt ist.
   */
  const stoodRef = useRef(false);
  const [grace, setGrace] = useState(false);
  useEffect(() => {
    if (open || preload) {
      stoodRef.current = true;
      setGrace(false);
      return;
    }
    if (!stoodRef.current) return;
    stoodRef.current = false;
    setGrace(true);
    const id = setTimeout(() => setGrace(false), UNMOUNT_GRACE_MS);
    return () => clearTimeout(id);
  }, [open, preload]);

  if (!open && !preload && !grace) return null;
  return <AssistantScreen />;
}
