import type { SearchStoreState } from "@/stores/searchStore";

/** Exakt der Auftrag, den der Speicher beim Öffnen hält — nur eben früher. */
type LocationPickerRequest = NonNullable<SearchStoreState["locationPickerRequest"]>;
type DatePickerRequest = NonNullable<SearchStoreState["datePickerRequest"]>;

/**
 * Den INHALT der beiden Picker schon beim Aufsetzen des Fingers bauen.
 *
 * Beide Blätter hängen zwar seit jeher dauerhaft am Wurzel-Layout — genau
 * damit beim ersten Öffnen kein Baum entsteht. Nur war der Baum bis dahin
 * LEER: Der Host liefert ohne Auftrag `suggested: []`, keine Überschrift und
 * `mode: "ALL"`. Die 10 bis 12 Vorschlagszeilen, die Überschrift und die
 * Modus-abhängige Filterung entstanden also doch erst im Öffnungs-Commit.
 *
 * Das kostete doppelt, und der zweite Teil ist der teurere:
 *
 *  1. Der Commit selbst liegt auf demselben Strang wie die Kurve.
 *  2. Beim Berühren des Feldes fordert `prepareLayer` eine GPU-Textur an. Die
 *     entstand damit von einem LEEREN Blatt — und der Öffnungs-Commit machte
 *     sie unmittelbar wieder ungültig. Die Textur half beim ersten Öffnen also
 *     nicht nur nicht, sie kostete zusätzlich: einmal bauen, verwerfen, mitten
 *     in der Bewegung neu bauen. Im Projekt sind dafür 66ms vermessen, bei
 *     einem Bildbudget von 8,3ms.
 *
 * Deshalb wird derselbe Auftrag, der beim Loslassen den Picker öffnet, schon
 * beim Aufsetzen hier gemeldet. Der Host rendert ihn dann mit `visible=false`
 * — sichtbar wird nichts, das Blatt steht weiter unterhalb des Bildrands. Beim
 * Loslassen bleibt nur noch das Schieben.
 *
 * Warum nicht über den Speicher: Ein Schreibvorgang dort weckt jeden
 * Abonnenten, und `locationPickerRequest`/`datePickerRequest` sind genau die
 * Felder, an denen der Hero seine Pause und seine Textur festmacht. Hier
 * sollen ausschließlich die beiden Hosts aufwachen — dieselbe Überlegung wie
 * in [[settingsPreload]], [[detailsPreload]] und `transitionLayer`.
 */
type LocationListener = (req: LocationPickerRequest) => void;
type DateListener = (req: DatePickerRequest) => void;

const locationListeners = new Set<LocationListener>();
const dateListeners = new Set<DateListener>();

export function subscribeLocationPreload(fn: LocationListener): () => void {
  locationListeners.add(fn);
  return () => {
    locationListeners.delete(fn);
  };
}

export function subscribeDatePreload(fn: DateListener): () => void {
  dateListeners.add(fn);
  return () => {
    dateListeners.delete(fn);
  };
}

export function preloadLocationPicker(req: LocationPickerRequest): void {
  for (const fn of locationListeners) fn(req);
}

export function preloadDatePicker(req: DatePickerRequest): void {
  for (const fn of dateListeners) fn(req);
}
