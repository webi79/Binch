/**
 * Den Profil-Unterschirm schon beim BERÜHREN der Kachel aufbauen.
 *
 * WOZU: Die Ergebnisliste und die Detail-Blätter sind dauerhaft gemountet —
 * beim Öffnen wird nur noch geschoben. Der Unterschirm dagegen entstand erst,
 * wenn der Speicher gesetzt wurde, also in dem Commit unmittelbar vor der
 * Bewegung. Und er ist kein kleiner Baum: „Einstellungen" allein sind rund 77
 * Elemente über dem Falz, mit Themen-Karten und eigenen Grafiken. Auf Fabric
 * läuft dieses Einhängen auf demselben Strang wie die Kurve.
 *
 * Dieselbe Überlegung wie beim Anlegen der GPU-Texturen: Zwischen Aufsetzen und
 * Loslassen liegen 80 bis 150ms, die ohnehin verstreichen. Dort ist Platz für
 * den Aufbau. Der Unterschirm steht dann geparkt rechts außerhalb — sichtbar
 * ist davon nichts —, und beim Loslassen bleibt nur noch das Schieben.
 *
 * WARUM EIN EIGENES MODUL und kein Speicher-Feld: Ein Schreibvorgang im Speicher
 * weckt alle Abonnenten, und das im Berührungs-Frame. Hier weckt es genau die
 * eine Überlagerung, um die es geht — dasselbe Vorgehen wie in
 * `lib/nav/transitionLayer.ts`.
 */
export type SettingsSubId = "details" | "settings" | "support";

type Listener = (id: SettingsSubId) => void;
const listeners = new Set<Listener>();

export function subscribeSettingsPreload(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Beim Fingerdruck auf eine Kachel aufrufen. */
export function preloadSettingsSub(id: SettingsSubId): void {
  for (const fn of listeners) fn(id);
}
