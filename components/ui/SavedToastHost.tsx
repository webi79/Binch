/**
 * SavedToastHost — "Ticket gespeichert" Toast-Popup (Premium-Glide).
 *
 *  - Aussehen und Bewegung: `GlideToast` (gleitet herein, Ring pulst einmal,
 *    Häkchen zeichnet sich, nach ~2.6s wieder hinaus)
 *  - User kann auf "Ansehen" tippen → Navigation + Cleanup
 *
 * Mount/Unmount-Pattern: solange kein Toast aktiv ist, ist nichts gemountet.
 * Keine Reanimated-Subscriptions, keine GestureDetector-Native-Recognizers
 * im Leerlauf.
 */

import { useCallback } from "react";
import { resultsPush, overlayCover } from "@/lib/nav/overlayCover";
import { Text } from "react-native";
import { useRouter } from "expo-router";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { useAccent } from "@/lib/theme/accent";
import { GlideToast } from "@/components/ui/GlideToast";

export function SavedToastHost() {
  const toast = useSearchStore((s) => s.savedToast);
  if (!toast) return null;
  return <Toast key={toast.key} />;
}

function Toast() {
  const hide = useSearchStore((s) => s.hideSavedToast);
  const router = useRouter();
  const t = useT();
  const accent = useAccent();
  // Store-Daten zu Mount-Zeit einlesen, danach nicht mehr subscriben —
  // die Toast-Lebenszeit ist von außen kontrolliert (HOLD_MS oder Klick).
  const toastData = useSearchStore.getState().savedToast;
  const clearSelectedResult = useSearchStore.getState().clearSelectedResult;

  const onPressCta = useCallback(() => {
    haptic("button");
    // Flag setzen damit der results-Screen seine 260ms Slide-Out-Animation
    // überspringt — sonst läuft die parallel zu Tab-Switch + Overlay-Unmount
    // = UI-Thread-Spike. Modal pop'pt instant, kein Konflikt.
    useSearchStore.getState().setBypassResultsSlideOut(true);
    hide();
    // dismissTo statt navigate: dismisst die Modal-Schichten UND switcht
    // die Tab in EINER atomaren Aktion. Vorher (router.navigate) machte
    // expo-router das in zwei separaten State-Updates, was dazu führte dass
    // der User einen Frame lang den Home-Tab sah (= Reanimated unfreeze
    // + Re-Mount-Churn) BEVOR der Saved-Tab fokussiert wurde.
    // Welches Ergebnis war offen, als getippt wurde? Im Handler lesen, nicht im
    // Render — dort würde es bei jedem Render überschrieben und der Wächter unten
    // verglichen gegen die NEUE Auswahl, also genau gegen die, die er schützen soll.
    // Den Öffnungs-Zähler, nicht die Kennung: Wer dieselbe Verbindung schließt
    // und gleich wieder öffnet, hat wieder dieselbe Kennung (siehe
    // `selectedResultSeq`).
    const openSeq = useSearchStore.getState().selectedResult
      ? useSearchStore.getState().selectedResultSeq
      : null;
    /**
     * Den Ergebnis-Bildschirm SOFORT wegstellen, bevor der Reiter wechselt.
     *
     * Die Marke oben überspringt nur seine Rückfahrt — stehen bleibt er
     * trotzdem, in voller Größe und an seiner Endposition, bis die Route beim
     * Wechsel abgeräumt wird. Der Reiter-Wechsel lief also über einen
     * bildschirmfüllenden Baum hinweg, der erst irgendwann darin verschwand.
     * Das ist das „ich bugge mich durch mehrere Reiter": Man sieht die
     * Ergebnisse, dann den darunterliegenden Reiter, dann das Ziel.
     *
     * Beides ohne Bewegung: Der Fortschritt springt auf 0 (der Baum liegt damit
     * rechts außerhalb, wo er im Ruhezustand ohnehin liegt), und der geteilte
     * Parallax-Wert geht mit, damit die Unterlage nicht verschoben stehenbleibt.
     * Sichtbar ist davon nichts — es passiert im selben Bild wie der Wechsel.
     */
    /**
     * ERST wechseln, DANN wegstellen — die Reihenfolge war falsch herum.
     *
     * Ich hatte den Ergebnis-Bildschirm vor dem Wechsel geparkt, damit der
     * Reiter-Wechsel nicht über ihn hinwegläuft. Damit lag aber für die Dauer
     * des Wechsels der Home-Reiter frei, und genau der blitzte auf. Der
     * Kommentar unten warnt seit jeher vor exakt diesem Bild.
     *
     * Richtig ist die andere Reihenfolge: Der Ergebnis-Bildschirm deckt den
     * Wechsel ab und verschwindet erst, wenn der Saved-Reiter darunter steht.
     * Zwei Bilder Abstand, weil der Wechsel selbst einen Commit braucht — dann
     * gibt es weder ein Aufblitzen noch ein Durchwandern.
     *
     * Ohne Bewegung: Der Fortschritt springt auf 0, also dorthin, wo der Baum im
     * Ruhezustand ohnehin liegt (rechts außerhalb). Der geteilte Parallax-Wert
     * geht mit, sonst bliebe die Unterlage verschoben stehen.
     */
    router.dismissTo("/(tabs)/saved");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        resultsPush.value = 0;
        overlayCover.value = 0;
        useSearchStore.getState().setResultsParams(null);
      }),
    );
    // KEINE direkte clearSelectedResult-Aufrufung mehr! Der DetailsContent-
    // Subtree ist riesig (useQuery + viele Reanimated-Hooks + ScrollView).
    // Ein synchrones Unmount während der Tab-Switch + Modal-Pop läuft,
    // war wahrscheinlich der UI-Thread-Spike der die App permanent laggig
    // anfühlen ließ. Stattdessen 2s deferred — bis dahin hat der User sich
    // visuell schon längst auf der Saved-Tab eingelebt, und das Unmount
    // passiert unsichtbar im Hintergrund.
    setTimeout(() => {
          // NUR löschen, wenn immer noch DAS Ergebnis offen ist, um das es hier
          // ging. Der Toast ist längst weg, wenn dieser Zeitgeber feuert — wer in
          // den zwei Sekunden zurück in die Liste geht und eine andere Karte
          // öffnet, bekam sein frisch geöffnetes Detail sonst kommentarlos wieder
          // zugemacht (die Aktion nullt auch die Bein-Zeitleiste mit).
          const st = useSearchStore.getState();
          if (openSeq == null || !st.selectedResult || st.selectedResultSeq !== openSeq) return;
          clearSelectedResult();
        }, 2000);
  }, [hide, router, clearSelectedResult]);

  if (!toastData) return null;

  const numStr = toastData.price.toFixed(0);
  const ccy = toastData.currency.toUpperCase();
  const pre = `${t("results.from").toUpperCase()} `;
  const post = ` ${ccy}`;

  return (
    <GlideToast
      title={t("toast.saved.title")}
      subtitle={
        <>
          {pre}
          <Text style={{ fontWeight: "800", color: accent.solid }}>{numStr}</Text>
          {post}
        </>
      }
      actionLabel={t("toast.saved.view")}
      onAction={onPressCta}
      onHidden={hide}
    />
  );
}
