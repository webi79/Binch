import { useAppBg } from "@/lib/theme/appBg";
import { useIsFocused } from "@react-navigation/native";
import { StatePanel } from "@/components/ui/StatePanel";
import { useT } from "@/lib/i18n/useT";
import { ms } from "@/lib/ui/compact";
import { SECTION_GAP } from "@/lib/theme/spacing";

/**
 * Abstand über dem Baustein — mit seinem eigenen Rand zusammen 48: unter
 * „Reisen | Tickets" bzw. unter der Karte „Ticket hinzufügen". So steht die
 * Zeichnung in beiden Reitern im selben Abstand zu dem, was darüber kommt.
 */
const emptyStyle = { marginTop: ms(SECTION_GAP) } as const;

interface Props {
  tab: "trips" | "tickets";
  /**
   * Ist dieses Empty-State-Panel gerade das SICHTBARE?
   *
   * Reicht nicht, nur auf `isFocused` (Saved-Tab offen) zu prüfen: Wechselt man
   * im Saved-Tab auf die Tickets-Ansicht, bleibt das Trips-Panel gemountet
   * (SlidingPanels hält beide) und läge nur off-screen. Die Herz-Schleife liefe
   * dann unsichtbar im Hintergrund weiter und fräße Performance. `active` schaltet
   * sie ab, sobald das Panel nicht das vordere ist.
   */
  active?: boolean;
}

/**
 * Leerer Zustand des Gespeichert-Tabs.
 *
 * Merkliste: eine Strichzeichnung (Herz vor einem Ticket), die sich zeichnet,
 * wenn das Panel zum ersten Mal zu sehen ist, und einmal schlägt — statt des
 * traurigen Bo mit schwebenden Herzen (04.11.2026: weniger Bo, ruhiger,
 * professioneller; siehe `StateArt`). Danach steht sie still und kostet
 * nichts, auch wenn der Tab gemountet bleibt.
 */
export function EmptyState({ tab, active = true }: Props) {
  const appBg = useAppBg();
  const t = useT();
  // Native-Bottom-Tabs halten alle Tab-Screens gemountet: gezeichnet wird erst,
  // wenn der Gespeichert-Tab offen UND dieses Panel das sichtbare ist.
  const isFocused = useIsFocused();
  const animate = isFocused && active;
  const titleKey =
    tab === "trips" ? "saved.empty.trips.title" : "saved.empty.tickets.title";
  const bodyKey =
    tab === "trips" ? "saved.empty.trips.body" : "saved.empty.tickets.body";

  // Beide Reiter mit DEMSELBEN Baustein und derselben Zeichnung (Herz vor
  // Ticket) — vorher stand bei den Tickets ein graues Symbol in einer Kachel,
  // das zu nichts anderem in der App passte (05.11.2026).
  return (
    <StatePanel
      art="favorites"
      active={animate}
      surface={appBg}
      title={t(titleKey)}
      body={t(bodyKey)}
      style={emptyStyle}
    />
  );
}
