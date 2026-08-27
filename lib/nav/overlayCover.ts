import { Easing, makeMutable, runOnJS, withTiming } from "react-native-reanimated";
import { markTransitionBusy } from "./transitionBusy";
import { setSheetMoving } from "./searchHandoff";
import { getDeviceCornerRadius } from "@/modules/screen-corners";

/**
 * Push-Übergänge — Werte aus echten Referenz-Implementierungen, nicht geschätzt.
 *
 * DREI QUELLEN, die sich decken:
 *
 * 1. React Navigation, packages/stack/src/TransitionConfigs/TransitionSpecs.tsx
 *    `FadeInFromRightAndroidSpec` und `FadeOutToLeftAndroidSpec` — also genau
 *    dieser Übergang, rein wie raus:
 *        animation: "timing", duration: 450,
 *        easing: Easing.bezier(0.20833, 0.82, 0.25, 1)
 *
 * 2. react-native-screens, res/v33/anim-v33/rns_default_enter_in.xml — was
 *    Android 13+ selbst fährt:
 *        duration: 450, interpolator: fast_out_extra_slow_in
 *    (dieselbe Dauer, und `fast_out_extra_slow_in` ist die Systemfassung
 *    derselben Kurvenform: kurzer Anlauf, langes weiches Auslaufen)
 *
 * 3. React Navigation, CardStyleInterpolators.tsx, `forHorizontalIOS` — der Weg
 *    der Unterlage:
 *        translateUnfocused: outputRange [0, screen.width * -0.3]
 *    also 30 % der Bildschirmbreite. Genau der Wert, der auch in
 *    rns_ios_from_right_background_open.xml steht (`toXDelta="-30%"`).
 *
 * WARUM DAS HIN UND HER: Es lief erst über eine eigene Feder mit 550ms
 * Nennwert — real das 1,5-fache, also rund 825ms, und das war zäh. Dann über die
 * 200ms aus der ÄLTEREN Fassung derselben Bibliothek (`rns_ios_*`, gedacht als
 * Notnagel für alte Android-Versionen) — und das war zu hastig. Die aktuelle
 * Vorgabe liegt bei 450ms, und zwar sowohl bei React Navigation als auch bei
 * Android selbst.
 *
 * Die Kurve tut genau das, was hier zweimal als Beschwerde ankam: Sie beginnt
 * bei Geschwindigkeit null (kein Stoß beim Losfahren) und läuft über mehr als
 * die halbe Dauer weich aus (kein Aufschlagen am Ende). Und weil sie exakt bei 1
 * endet, braucht es keinen Beschnitt wie bei einer Feder.
 */
/**
 * Kurve: gleichmäßig statt betont.
 *
 * Vorher stand hier `bezier(0.20833, 0.82, 0.25, 1)` — die „Emphasized"-Form aus
 * React Navigations Android-Vorgaben. Rechnet man sie aus, erreicht sie **82 %
 * der Strecke in den ersten 21 % der Zeit** und kriecht den Rest. Auf der
 * reinslidenden Ebene fällt das kaum auf (sie hat viel Weg), auf der Unterlage
 * ist dieser Stoß aber die GANZE Bewegung — sie legt nur 30 % der Breite zurück.
 * Genau das kam als „sprunghaft, hektisch" an.
 *
 * Die Datei hatte diesen Zusammenhang schon einmal dokumentiert und die Form
 * deshalb verworfen; ich habe sie mit den Referenzwerten versehentlich
 * zurückgeholt. Die Messreihe von damals:
 *
 *   Emphasized-Decelerate   34,9 % Spitze pro Bild   10,5× das Mittel
 *   Emphasized (Standard)   23,6 %                    7,1×
 *   gleichmäßige Kurve       ~9 %                     rund 2×
 *
 * `bezier(0.4, 0, 0.2, 1)` ist Materials Standard-Kurve: sanftes Anlaufen,
 * langes weiches Auslaufen, Spitze in der Mitte statt am Anfang. Dazu 500ms —
 * Material sieht für bildschirmfüllende Übergänge bis dahin vor, und länger war
 * ausdrücklich gewünscht.
 */
const EMPHASIZED = Easing.bezier(0.4, 0, 0.2, 1);

/**
 * 430ms hinein, 380 hinaus — vorher 500/450.
 *
 * Die Kurve bleibt unangetastet: Sie läuft sanft an und lange aus, und genau das
 * soll erhalten bleiben. Verkürzt wird nur die Strecke in der Zeit.
 *
 * Warum nicht deutlich weniger: Die Referenzen liegen bei 450ms (React
 * Navigations `FadeInFromRightAndroidSpec`, react-native-screens
 * `rns_default_enter_in.xml`), und darunter zu gehen kostet den Auslauf, der
 * diesen Übergang trägt — bei 300ms bleibt von „langsam werden zum Ende hin"
 * nichts übrig, was man noch sähe. 430/380 ist rund ein Sechstel schneller: im
 * direkten Vergleich merklich, ohne die Form der Bewegung zu verlieren.
 *
 * Der Parallax der Unterlage hängt an denselben Werten (siehe COVER_IN_SPRING
 * darunter) — beide Ebenen bleiben damit zwangsläufig synchron.
 */
export const PUSH_SPRING = { duration: 430, easing: EMPHASIZED } as const;
export const POP_SPRING = { duration: 380, easing: EMPHASIZED } as const;

/** Unterlage läuft mit derselben Kurve — beide Ebenen als ein Körper. */
export const COVER_IN_SPRING = PUSH_SPRING;
export const COVER_OUT_SPRING = POP_SPRING;

/**
 * Geteilter Parallax-Fortschritt der horizontalen Push-Overlays.
 * 0 = kein Overlay (Unterlay in Ruhe), 1 = Overlay voll drin (Unterlay
 * maximal verschoben). Wird von den Overlays synchron zu ihrer Slide
 * getrieben, im Root gelesen (Stack-Parallax).
 *
 * makeMutable statt useSharedValue: modulweit geschrieben/gelesen.
 */
export const overlayCover = makeMutable(0);


/**
 * EIN Fortschritt für die Ergebnis-Slide: 0 = ganz rechts außerhalb,
 * 1 = deckt den Bildschirm.
 *
 * Vorher waren das drei getrennte Animationen (Slide, Parallax, Beschnitt), die
 * zufällig dieselbe Dauer hatten. Drei Federn gleichzeitig kosten nicht nur
 * unnötig Zeit auf dem UI-Thread — sie können auch minimal auseinanderlaufen,
 * und schon das liest sich als Ruckeln. Jetzt läuft EINE Animation, alle drei
 * leiten ihren Wert daraus ab und sind damit bildgenau gekoppelt.
 *
 * Bewusst getrennt von `overlayCover`: Den liest der Ergebnis-Screen selbst, um
 * beiseite zu rücken, wenn ein Detail-Overlay über IHN kommt. Mit demselben Wert
 * schöbe er sich beim Reinkommen selbst zur Seite.
 */
export const resultsPush = makeMutable(0);

/**
 * Früher wurde der Fortschritt bei 98% geklemmt, weil eine Feder ihr Ziel nur
 * asymptotisch erreicht und dabei am linken Rand einen Streifen offenließ.
 *
 * Mit einer Zeitkurve gibt es das Problem nicht: Sie endet exakt bei 1. Die
 * Funktion bleibt als Durchreiche stehen, damit die Aufrufer unverändert
 * bleiben — und weil sie die Stelle markiert, an der man es wieder bräuchte,
 * falls hier je wieder eine Feder steht.
 */
export function pushProgress(p: number): number {
  "worklet";
  return p;
}


/**
 * Parallax-Weg der Unterlage als Bruchteil der Bildschirmbreite (negativ = links).
 *
 * 30 %. Der Wert steht so auch in React Navigation (`forHorizontalIOS`:
 * `screen.width * -0.3`) und in react-native-screens
 * (`rns_ios_from_right_background_open.xml`: `toXDelta="-30%"`).
 *
 * Der Text hier nannte lange 15 % und stammte aus einer Zwischenstufe — die Zahl
 * darunter war da längst wieder auf den Referenzwert gesetzt.
 */
export const UNDERLAY_TRAVEL_FRAC = -0.30;

/**
 * Eckenradius der horizontal reinslidenden Screens (results + Detail-Overlays).
 *
 * Sie slideten früher mit eckigen Ecken rein. Der Radius rundet die führende
 * Kante beim Reinsliden ab und lässt den Screen im Stand wie eine Karte wirken,
 * deren Ecken zur Bildschirm-Rundung des Geräts passen.
 *
 * Umgesetzt via `borderRadius` + `overflow: "hidden"`. Das ist HIER günstig: Der
 * View wird nur VERSCHOBEN (nicht ein Kind darin rotiert), also nutzt Android
 * Umgesetzt via `borderRadius` + `overflow: hidden`. ACHTUNG: Die frühere
 * Behauptung, Android nutze dafür `clipToOutline` (GPU-seitig, kein Neurastern
 * pro Bild), stimmt für RN 0.81 NICHT. `BackgroundStyleApplicator.kt` ruft bei
 * runden Ecken `canvas.clipPath(...)` und legt in `createPaddingBoxPath` bei
 * jedem Aufruf einen frischen `Path` an — der Clip fällt also pro Bild an. Über
 * einer Fläche ohne GPU-Ebene ist das ein echter Posten; siehe `SLIDE_LIFT` in
 * `AssistantScreen.tsx`.
 * Frame (anders als beim Swap-Button, wo ein Kind IM Clip rotierte).
 *
 * Der Wert kommt jetzt vom ECHTEN Geräteradius (natives Modul screen-corners):
 *   - modernes Android/iOS mit rundem Bezel → exakter Radius
 *   - Gerät mit eckigem Display → 0 → Ecken bleiben eckig (korrekt)
 *   - Radius nicht bestimmbar (Modul nicht gebaut, z.B. Dev-Client ohne
 *     EAS-Rebuild) → null → wir nehmen FALLBACK_RADIUS
 *
 * Konstante beim Modul-Load einmal gelesen — reicht, der Wert ändert sich zur
 * Laufzeit nicht.
 */
const FALLBACK_RADIUS = 40;
const measuredRadius = getDeviceCornerRadius();
export const SCREEN_CORNER_RADIUS =
  measuredRadius != null ? measuredRadius : FALLBACK_RADIUS;


/**
 * Startet die Ergebnis-Slide SOFORT beim Tippen — nicht erst, wenn der
 * Zielbildschirm steht.
 *
 * Vorher hing die Bewegung am Mounten: tippen → navigieren (18-41ms) → Bildschirm
 * aufbauen (~20ms) → auf einen freien Thread warten → losfahren. Selbst im besten
 * Fall lagen 60-80ms zwischen Finger und erster Bewegung, und genau das ist die
 * Verzögerung, die man spürt.
 *
 * Der Punkt: Die Unterlage braucht den Zielbildschirm überhaupt nicht. Ihr
 * Parallax hängt allein an diesem Wert, und der lebt auf dem UI-Thread. Er kann
 * loslaufen, während React noch arbeitet. Der Ergebnis-Bildschirm leitet seine
 * Position aus demselben Wert ab — er steigt beim Mounten also einfach an der
 * Stelle ein, an der die Bewegung gerade ist, statt sie anzuführen.
 *
 * Sichtbar bleibt davon nichts: In den ~50ms bis zum Mounten liegt der
 * Fortschritt bei rund 10%, die Unterlage ist also 2% der Breite gewandert. Der
 * dabei freiwerdende Streifen am rechten Rand ist wenige Pixel breit und zeigt
 * die App-Hintergrundfarbe — dieselbe, die auch der Ergebnis-Bildschirm trägt.
 */
/**
 * Zählt, wie oft eine Ergebnis-Slide gestartet wurde.
 *
 * `resultsPush` ist modulweit. Wer ihn beim Abbau zurücksetzt, muss wissen, ob er
 * noch der Eigentümer ist — sonst parkt eine abgebaute Instanz eine andere, die
 * gerade hereinfährt, unsichtbar außerhalb des Bildes.
 */
let pushGen = 0;
let lastPushAt = 0;

export function pushGeneration(): number {
  return pushGen;
}

/**
 * Millisekunden seit dem letzten Start einer Ergebnis-Slide.
 *
 * Der Ergebnis-Bildschirm braucht beim Mounten die Antwort auf „hat jemand schon
 * für mich gestartet?". Über den Wert selbst zu prüfen ginge zwar, sein Getter
 * macht auf dem JS-Thread aber einen SYNCHRONEN Sprung in die UI-Runtime — beide
 * Threads werden dabei kurz gegeneinander gesperrt, ausgerechnet während die
 * Feder läuft. Der Zähler allein reicht nicht, weil er „schon gestartet" nicht
 * von „Direktlink" unterscheiden kann. Eine Uhr schon.
 */
export function msSinceResultsPush(): number {
  return Date.now() - lastPushAt;
}

/**
 * Fährt der Such-Screen bei der nächsten Bewegung mit?
 *
 * Gesetzt beim Tippen auf „Suchen", eingelöst von `startResultsPush`. Ein
 * einfacher Modul-Wert reicht: Gelesen wird er nur hier, nie im Render.
 */
let heroClipArmed = false;

/** Beim Suchen AUS dem Such-Screen aufrufen. */
export function armHeroClip(): void {
  heroClipArmed = true;
}

/**
 * Alle Bewegungswerte EINMAL durch ihre echten Kurven schicken.
 *
 * Reanimated baut pro Kurve beim ersten Lauf einiges auf — die Bézier-Tabelle,
 * den Zeitgeber-Pfad, die Anbindung an den geteilten Wert. Das passierte bisher
 * nur für `resultsPush` und den Parallax; die vier anderen Übergänge liefen bei
 * ihrer ERSTEN echten Verwendung kalt an. Genau das kam wiederholt als „beim
 * ersten Mal ruckelt es" zurück, und zwar bei jedem der betroffenen Blätter
 * einzeln.
 *
 * Die Wege sind winzig (0,002) und die Werte stehen dabei außerhalb des Bildes
 * oder auf ihrer Ruhestellung — sichtbar ist nichts. Wichtig ist nur, dass
 * dieselben Konfigurationen benutzt werden wie später: Ein Aufwärmen mit einer
 * ANDEREN Kurve wärmt den falschen Pfad, und genau dieser Fehler steckte in den
 * beiden Pickern.
 *
 * Jeder Rückruf prüft `finished`. Startet in diesem Fenster ein echter Übergang,
 * bricht er das Aufwärmen ab — ohne die Prüfung zöge der Rückruf den Wert
 * mitten in der echten Bewegung wieder auf 0.
 */
export function warmPushCurves(): void {
  type Curve = Parameters<typeof withTiming>[1];
  const warm = (v: typeof resultsPush, cfg: Curve) => {
    v.value = 0;
    v.value = withTiming(0.002, cfg, (finished?: boolean) => {
      "worklet";
      if (!finished) return;
      v.value = 0;
    });
  };
  warm(detailsPush, PUSH_SPRING);
  warm(ticketPush, PUSH_SPRING);
  warm(settingsPush, PUSH_SPRING);
  warm(assistantPush, ASSISTANT_IN);
  warm(searchHeroPush, PUSH_SPRING);
  // Fehlte als einzige. Sie treibt zwei bildschirmfüllende Auswerter bei der
  // Übergabe vom Such-Blatt an die Ergebnisliste — der allererste Übergang
  // dorthin lief deshalb kalt.
  warm(heroClipPush, PUSH_SPRING);
}

export function startResultsPush(): void {
  markTransitionBusy(PUSH_SPRING.duration);
  /**
   * Auch beim Textur-Riegel anmelden.
   *
   * An `isSheetMoving()` hängt die Regel in `transitionLayer.ts`, dass eine
   * GPU-Ebene während einer Fahrt nicht abgerissen wird. Angemeldet haben sich
   * bisher nur Bo, das Such-Blatt und die beiden Wähler — für Ergebnisliste,
   * Detail- und Ticket-Blatt konnte die 1,4-Sekunden-Frist also mitten in die
   * Fahrt fallen und die Ebene wegnehmen. Ein Ebenen-Abbau hält die laufende
   * Bewegung an; genau das beschreibt `transitionLayer.ts` als den Fall, für
   * den der Riegel überhaupt existiert.
   */
  setSheetMoving(true, "results");
  pushGen += 1;
  lastPushAt = Date.now();
  resultsPush.value = 0;
  resultsPush.value = withTiming(1, PUSH_SPRING, (finished) => {
    "worklet";
    if (!finished) return;
    runOnJS(setSheetMoving)(false, "results");
  });
  // Beide Bewegungen im SELBEN Aufruf starten.
  //
  // Der Beschnitt des Such-Screens wurde vorher direkt im Tipp-Handler gestartet,
  // die Bewegung der Ergebnisliste erst zwei Bilder später: Dazwischen liegen ein
  // `requestAnimationFrame`, das Schreiben in den Speicher, ein React-Render und
  // noch ein `requestAnimationFrame`. Beide liefen mit derselben Kurve über
  // dieselbe Dauer — nur eben um zwei Bilder versetzt.
  //
  // Sichtbar ist dieser Versatz die ganze Bewegung lang: Der Such-Screen weicht
  // durchgehend ein Stück weiter zur Seite, als die Kante der hereinfahrenden
  // Liste steht. An der Kante klafft damit ein wandernder Spalt, und am Ende hört
  // der eine zwei Bilder vor dem anderen auf. Genau das war „aus dem Suchscreen
  // heraus buggt die Slide durch" — aus dem Landingscreen gibt es diesen zweiten
  // Wert gar nicht, und von dort war die Bewegung sauber.
  //
  // Vom selben Wert ablesen ginge auch, kostet aber bei JEDER Suche zwei
  // bildschirmfüllende Mapper, die für den nicht offenen Such-Screen garantiert
  // null rechnen. Deshalb weiterhin ein eigener Wert — nur eben gleichzeitig
  // gestartet.
  if (heroClipArmed) {
    heroClipArmed = false;
    heroClipPush.value = 0;
    heroClipPush.value = withTiming(1, PUSH_SPRING);
  }
}

/**
 * Fortschritt NUR für den Beschnitt des Such-Screens.
 *
 * Vorher las er `resultsPush` mit. Der Screen hängt aber dauerhaft am Root — bei
 * jeder Suche aus dem Landingscreen liefen seine zwei Mapper damit trotzdem
 * jedes Bild, rechneten garantiert null und schrieben pro Bild einen Transform
 * auf zwei bildschirmfüllende Ansichten. Über einen eigenen Wert, den nur die
 * Übergabe aus dem Such-Screen anfasst, laufen sie dort gar nicht erst an.
 */
export const heroClipPush = makeMutable(0);

/**
 * Fortschritt des Such-Blattes: 0 = ganz rechts außerhalb, 1 = deckt den Schirm.
 *
 * Dasselbe Muster wie `resultsPush` und `assistantPush` — das Blatt kommt von
 * rechts herein und schiebt den Landingscreen im Parallax mit. Vorher fuhr es
 * von unten herein und hatte mit den übrigen Übergängen der App nichts gemein.
 */
export const searchHeroPush = makeMutable(0);

let searchHeroMoving = false;
/** Läuft die Fahrt schon? Als JS-Wert — Begründung siehe `isDetailsPushStarted`. */
export function isSearchHeroPushStarted(): boolean {
  return searchHeroMoving;
}

/**
 * Im TIPP-Handler aufrufen, nicht im Öffnungs-Effekt.
 *
 * Bis eben startete die Bewegung erst am Ende einer Kette: Speicher schreiben
 * (acht Felder auf einmal) → Effekt → zwei weitere Speicher-Schreibvorgänge →
 * Commit → die Rücksetz-Effekte des Formulars mit acht `setState` → Effekt →
 * ein Bild Wartezeit → los. Das sind zwei Bilder und drei Commits zwischen
 * Finger und erster Bewegung, und genau die spürt man als Verzug.
 *
 * Alle anderen Übergänge der App starten im Tipp-Handler; der Fortschritt ist
 * ein Modul-Wert und braucht den Bildschirm dafür gar nicht. Der Effekt im
 * Blatt bleibt als Notausgang für Wege, die hier nicht vorbeikommen.
 */
let searchHeroArrivedCb: (() => void) | null = null;
/**
 * Was NACH der Einfahrt laufen soll — vom Blatt einmal hinterlegt.
 *
 * Nötig, weil die Kurve im Tipp-Handler startet, die Aufräumarbeit danach aber
 * im Blatt liegt (Textur freigeben, Sonnenaufgang, Einblend-Takt). Ein fester
 * Verteiler statt eines eingefangenen Rückrufs: Ein Worklet fängt seine
 * Schließung beim Anlegen ein und sähe eine später gesetzte Funktion nie.
 */
export function setSearchHeroArrivedHandler(fn: (() => void) | null): void {
  searchHeroArrivedCb = fn;
}
function searchHeroArrived(): void {
  searchHeroArrivedCb?.();
}

export function startSearchHeroPush(): void {
  markTransitionBusy(PUSH_SPRING.duration);
  /**
   * Auch beim Textur-Riegel anmelden, nicht nur bei der Leerlauf-Sperre.
   *
   * An `isSheetMoving()` hängt die Regel in `transitionLayer.ts`, dass eine
   * GPU-Ebene während einer Fahrt NICHT abgerissen wird. Ohne die Anmeldung
   * konnte die 1,4-Sekunden-Frist der Unterlagen-Textur mitten in die Fahrt
   * fallen — ein Ebenen-Abbau hält die laufende Bewegung an. Genau das
   * „manchmal ruckelt es, manchmal nicht". Bo meldet sich seit Längerem an,
   * dieses Blatt nicht.
   */
  setSheetMoving(true, "searchHero");
  searchHeroMoving = true;
  // Kein Rückwurf auf 0 — dieselbe Begründung wie bei `startDetailsPush`: Wer
  // mitten in der Ausfahrt erneut tippt, soll von dort weiterfahren, statt
  // erst eine volle Breite nach rechts aus dem Bild zu springen.
  searchHeroPush.value = withTiming(1, PUSH_SPRING, (finished) => {
    "worklet";
    if (!finished) return;
    runOnJS(searchHeroArrived)();
  });
}

/** Beim Schließen — der Aufrufer räumt danach auf. */
export function endSearchHeroPush(): void {
  markTransitionBusy(POP_SPRING.duration);
  setSheetMoving(true, "searchHero");
  searchHeroMoving = false;
}

/** Abmelden — vom Blatt aufgerufen, wenn die Fahrt wirklich durch ist. */
export function searchHeroSettled(): void {
  setSheetMoving(false, "searchHero");
}


/**
 * Fortschritt des Profil-Unterschirms: 0 = Hub, 1 = Unterschirm liegt oben.
 *
 * Modulweit, weil die beiden Ebenen inzwischen in VERSCHIEDENEN Bäumen hängen:
 * Der Hub liegt im Tab, der Unterschirm am Wurzel-Layout — nur von dort kann er
 * die native Tab-Leiste überdecken. Ein geteilter Wert verbindet sie, ohne dass
 * ein Zustand durch beide Bäume gereicht werden muss.
 */
export const settingsPush = makeMutable(0);

/**
 * DIE Zeitvorgabe für alle Blätter, die von unten hereinfahren.
 *
 * Bisher stand sie an sieben Stellen einzeln im Code — jedes Blatt hatte die
 * Zahlen vom vorigen abgeschrieben (der Anmelde-Screen gab sie vor, das
 * Such-Blatt übernahm sie, Bo und das Ticket-Blatt wieder von dort). Das hielt
 * nur, solange niemand eine davon anfasst. Genau das steht jetzt an: Sie sollen
 * schneller werden, und zwar alle gemeinsam, sonst fährt der eine Knopf anders
 * als der daneben.
 *
 * 280ms statt 350 hinein, 240 statt 300 hinaus. Ein Blatt von unten legt einen
 * kurzen Weg zurück; die 350 stammen aus Reanimateds Vorgabe für `SlideInDown`
 * und sind für einen bildschirmfüllenden Wechsel gedacht, nicht für etwas, das
 * man mehrmals hintereinander auf- und zumacht. Hinaus darf kürzer sein als
 * hinein — wer schließt, hat die Entscheidung schon getroffen.
 *
 * DIE KURVE ist nicht mehr `Easing.inOut(Easing.quad)`.
 *
 * Die alte war Reanimateds Standard für `SlideInDown`, und sie wirkt linear —
 * zu Recht. Nachgerechnet liegt sie bei halber Zeit auf EXAKT halber Strecke,
 * also genau auf der Geraden; nennenswert langsamer wird sie erst auf den
 * letzten 22% der Zeit. Die Kurve der Seitwärts-Slides lässt sich für dieselben
 * letzten 10% Weg dagegen 37% der Zeit:
 *
 *   Anteil der Zeit, nach dem 90% des Weges zurückgelegt sind
 *     inOut(quad)          78%   → Auslauf über die restlichen 22%
 *     bezier(.4, 0, .2, 1) 63%   → Auslauf über die restlichen 37%
 *
 * Welche Kurve es genau ist, steht bei SHEET_EASE darunter.
 */
/**
 * Eigene Kurve für die Blätter — NICHT die der Seitwärts-Slides.
 *
 * Dass beide dieselbe bekommen sollten, war der Fehlschluss. `EMPHASIZED`
 * (`bezier(.4, 0, .2, 1)`) legt die HALBE Strecke in den ersten 35% der Zeit
 * zurück; die Spitzengeschwindigkeit liegt beim 2,7-fachen des Mittels. Auf der
 * Bildschirmbreite geht das gut auf, ein Blatt von unten legt aber die ganze
 * Bildschirmhöhe zurück — dieselbe Form ergibt dort deutlich mehr Weg pro Bild
 * am Anfang, und genau das kam als „hastig, wirkt ruckelig" zurück.
 *
 * Diese hier hat die Spitze der ursprünglichen Kurve, aber den Auslauf der
 * neuen:
 *
 *                          Spitze/Mittel   50% bei   90% bei
 *   inOut(quad)  („linear")     2,00x        50%       78%
 *   bezier(.4,0,.2,1) („hastig") 2,73x       35%       63%
 *   bezier(.4,0,.4,1)  HIER      2,04x       43%       71%
 *
 * Also: kein schnellerer Anlauf als vorher (2,04 gegen 2,00), aber die letzten
 * 10% des Weges dauern jetzt 29% der Zeit statt 22%. Genau das war gewünscht —
 * langsamer werden zum Ende hin, ohne vorne zu schnellen.
 */
const SHEET_EASE = Easing.bezier(0.4, 0, 0.4, 1);

/**
 * 300/260. Zwischenzeitlich standen hier 320/280, um den vorgezogenen Weg der
 * `EMPHASIZED`-Kurve auszugleichen. Mit der milderen Kurve braucht es diesen
 * Ausgleich nicht mehr: Gerechnet auf den Punkt, an dem 90% zurückgelegt sind,
 * liegt sie bei 71% von 300ms = 213ms — praktisch gleichauf mit den 218ms der
 * ursprünglichen Fassung, deren Tempo als richtig bezeichnet wurde.
 */
/**
 * 300/260 — bewusst NICHT verlangsamt.
 *
 * Die Rechnung unten stimmt, die Schlussfolgerung war trotzdem falsch: Langsamer
 * ist nicht dasselbe wie flüssiger. Sie bleibt hier stehen, weil sie die
 * Verhältnisse festhält — nicht als Aufforderung, an der Zahl zu drehen.
 *
 * Die Kurve war nie das Problem: Sie ist projektweit dieselbe, und die Wähler
 * benutzen wertgleiche Konstanten. Das Missverhältnis liegt zwischen STRECKE
 * und ZEIT. Ein Blatt von unten legt die volle Fensterhöhe zurück, ein
 * Seitwärts-Slide nur die Breite:
 *
 *     Seitwärts   411dp / 430ms  →  43 Punkte pro Bild bei 60Hz
 *     Blatt       801dp / 300ms  →  90 Punkte pro Bild
 *
 * Die Blätter bewegen sich also mehr als doppelt so schnell pro Bild wie die
 * Slides, die im selben Projekt als weich gelten. Bei so großen Schritten
 * zwischen zwei Bildern sieht das Auge die Einzelbilder — und zwar unabhängig
 * davon, ob eines ausfällt. Genau das ist der Rest, der nach allen Aufräum-
 * arbeiten übrig blieb: kein Ruckler im technischen Sinn, sondern zu viel Weg
 * pro Bild.
 *
 * Die Konstante gilt für alle Blätter von unten — sie bleiben untereinander
 * identisch, und `PICKER_IN`/`PICKER_OUT` sind buchstäblich dieselbe, damit sie
 * nicht wieder auseinanderlaufen.
 */
export const SHEET_IN = { duration: 300, easing: SHEET_EASE } as const;
export const SHEET_OUT = { duration: 260, easing: SHEET_EASE } as const;

/**
 * Ort- und Datumswähler fahren etwas zügiger als die großen Blätter.
 *
 * Eigene Zahlen und nicht die gemeinsamen verstellt: An `SHEET_IN` hängen auch
 * das Such-Blatt aus dem Landingscreen und Bos Bildschirm, und deren Tempo ist
 * ausdrücklich als richtig bezeichnet worden. Die beiden Picker sind aber etwas
 * anderes — sie legen sich über einen Bildschirm, auf dem man gerade
 * weiterarbeitet, und dürfen deshalb direkter kommen.
 *
 * 250/220 statt 300/260, also rund ein Sechstel schneller. Bewusst nicht
 * darunter: Die KURVE bleibt dieselbe, und mit ihr braucht es genug Zeit, damit
 * das Auslaufen am Ende noch als Auslaufen lesbar ist. Unter etwa 200ms kippt
 * eine Bewegung ins Aufblitzen — sie wirkt dann nicht schneller, sondern
 * abwesend.
 */
/**
 * GLEICHE Dauer wie das Such-Blatt — 300/260 statt 250/220.
 *
 * Die Kurve war schon dieselbe, die Strecke auch: Beide fahren die volle
 * Fensterhöhe. Nur die Zeit war kürzer, und das heißt bei gleicher Strecke
 * höhere Geschwindigkeit — bei rund 800 Punkten Weg gut 100 Punkte pro Bild
 * statt 85. Weniger Bilder für dieselbe Strecke bedeutet größere Sprünge
 * zwischen ihnen, und das liest sich als „ruckelig", auch wenn kein einziges
 * Bild ausfällt.
 *
 * Das Blatt, das als weich empfunden wird, fährt 300/260. Es gibt keinen Grund,
 * warum ausgerechnet diese beiden schneller sein sollten — zumal sie direkt
 * darauf aufsetzen und der Unterschied im Wechsel auffällt.
 */
export const PICKER_IN = SHEET_IN;
export const PICKER_OUT = SHEET_OUT;

/**
 * Bo fährt VON UNTEN herein, nicht von rechts — wie das Such-Blatt und der
 * Anmelde-Screen.
 *
 * Deshalb auch andere Zahlen als die Push-Übergänge oben: Ein Blatt von unten
 * legt einen kürzeren Weg zurück und darf nicht so lange brauchen wie ein
 * Bildschirmwechsel zur Seite. `BinchAuthScreen` gibt die Vorgabe
 * (`SlideInDown.duration(350)` / `SlideOutDown.duration(300)`), das Such-Blatt
 * hat sie übernommen, und `Easing.inOut(Easing.quad)` ist die Standardkurve, mit
 * der Reanimated diese beiden Bewegungen fährt.
 *
 * 0 = unterhalb des Bildrands, 1 = oben angekommen.
 */
/**
 * Bo fährt die PUSH-Bewegung — dieselbe wie Ergebnisliste, Detail-Blatt und
 * Profil-Unterschirm: von rechts herein, die Unterlage wandert im Parallax mit.
 *
 * Vorher war es ein Blatt von unten (`SHEET_IN`/`SHEET_OUT`). Das war eine
 * zweite Sprache für dieselbe Sache — die App kennt genau einen Weg, wie ein
 * Bildschirm über einen anderen kommt, und der steht hier oben. Wer die Kurven
 * ändert, ändert sie für alle gemeinsam; genau dafür sind sie zentral.
 */
export const ASSISTANT_IN = PUSH_SPRING;
export const ASSISTANT_OUT = POP_SPRING;

export const assistantPush = makeMutable(0);

/**
 * Fortschritt des Detail-Blattes („Auswählen" an einer Ticket-Karte).
 * 0 = rechts außerhalb, 1 = deckt den Bildschirm.
 *
 * WARUM DAS AUS DER KOMPONENTE RAUS MUSSTE — es ist derselbe Befund wie bei
 * `startResultsPush`, nur eine Ebene tiefer:
 *
 * Die Bewegung hing an einem Wert INNERHALB des Blattes und startete in einem
 * Effekt. Zwischen Finger und erster Bewegung lag damit die ganze Kette
 * Speicher schreiben → alle Abonnenten wecken → das Detail-Blatt mit einem NEUEN
 * Ticket durchrendern → Fabric committen → Effekt → ein Bild Vorlauf. Der Commit
 * ist dabei nicht klein: Es ist der komplette Blatt-Inhalt mit anderen Daten.
 *
 * Genau das kam als „braucht voll lange, bis die Animation getriggert wird" an.
 * Von hier aus startet sie im Berührungs-Frame, und der Commit läuft daneben,
 * statt davor.
 */
export const detailsPush = makeMutable(0);

/**
 * Fortschritt des Ticket-Blattes im Saved-Reiter. 0 = draußen, 1 = angekommen.
 *
 * Es war die EINZIGE Seitwärts-Slide, die ihre Bewegung nicht im Tipp startete,
 * sondern in einem Effekt mit einem Bild Vorlauf — also erst, nachdem der
 * Speicher-Schreibvorgang alle Abonnenten geweckt und Fabric committet hatte.
 * Der Kommentar dort begründet den Vorlauf damit, dass der Baum dauerhaft steht
 * und es „gar keinen Aufbau-Commit" gebe, auf den zu warten wäre — das stimmt,
 * macht die Wartezeit aber gerade deshalb zu reiner Latenz.
 */
export const ticketPush = makeMutable(0);

let ticketMoving = false;
export function isTicketPushStarted(): boolean {
  return ticketMoving;
}

export function startTicketPush(): void {
  setSheetMoving(true, "ticket");
  markTransitionBusy(PUSH_SPRING.duration);
  ticketMoving = true;
  ticketPush.value = withTiming(1, PUSH_SPRING, (finished) => {
    "worklet";
    if (!finished) return;
    runOnJS(setSheetMoving)(false, "ticket");
  });
  overlayCover.value = withTiming(1, COVER_IN_SPRING);
}

export function endTicketPush(): void {
  markTransitionBusy(POP_SPRING.duration);
  ticketMoving = false;
}

/**
 * Beide Bewegungen in EINEM Aufruf — die des Blattes und der Parallax der
 * Unterlage.
 *
 * Sie liefen vorher in zwei getrennten Zuweisungen an derselben Stelle, was
 * hier gut ging; sobald aber eine davon im Tipp-Handler und die andere im
 * Effekt startet, laufen sie um zwei Bilder versetzt. Wie sich das liest, steht
 * ausführlich bei `startResultsPush`: ein wandernder Spalt an der Kante.
 */
/**
 * Läuft die Bewegung? Als schlichter JS-Wert, NICHT über den geteilten Wert.
 *
 * Das Blatt muss unterscheiden können, ob jemand die Bewegung schon angestoßen
 * hat — sonst startet sein Notausgang eine zweite. Nachgelesen wurde das bis
 * eben mit `detailsPush.value` aus React heraus, und das ist teuer an der
 * falschen Stelle: Ein Zugriff aus JS auf einen geteilten Wert ist ein
 * SYNCHRONER Sprung in die UI-Laufzeit, bei dem beide Stränge kurz gegeneinander
 * gesperrt werden — ausgerechnet während die Kurve läuft. Die Datei warnt weiter
 * oben selbst davor.
 *
 * Ein einfaches Modul-Flag beantwortet dieselbe Frage, ohne irgendetwas zu
 * sperren.
 */
let detailsMoving = false;
export function isDetailsPushStarted(): boolean {
  return detailsMoving;
}

export function startDetailsPush(): void {
  markTransitionBusy(PUSH_SPRING.duration);
  setSheetMoving(true, "details");
  detailsMoving = true;
  // Kein Rückwurf auf 0 davor. `withTiming` startet ohnehin beim aktuellen Wert
  // — und genau das ist hier das bessere Verhalten: Wer mitten in der Rückfahrt
  // erneut auf eine Karte tippt, soll von dort aus weiterfahren statt erst nach
  // rechts aus dem Bild zu springen. Der Wurf war zusätzlich ein eigener
  // Auftrag an den UI-Strang, also ein Zustellvorgang mehr im heikelsten Moment.
  detailsPush.value = withTiming(1, PUSH_SPRING, (finished) => {
    "worklet";
    if (!finished) return;
    runOnJS(setSheetMoving)(false, "details");
  });
  overlayCover.value = withTiming(1, COVER_IN_SPRING);
}

/** Vom Blatt gesetzt, wenn es seine Rückfahrt fährt — die schreibt es selbst,
 *  hier gibt es dafür keine Gegenfunktion (siehe `DetailsOverlay`). */
export function setDetailsPushStopped(): void {
  detailsMoving = false;
}


/**
 * Startet Bos Bewegung SCHON BEIM TIPPEN, nicht erst wenn der Bildschirm steht.
 *
 * Derselbe Kniff wie bei `startResultsPush`, aus demselben Grund: Zwischen
 * Fingerkontakt und dem ersten gemounteten Bild liegen Navigation, Aufbau des
 * Bildschirms und ein freier UI-Thread — 60 bis 80ms, in denen nichts passiert.
 * Wird die Bewegung stattdessen im Tipp-Handler losgeschickt, läuft sie bereits,
 * wenn der Bildschirm auftaucht: Er erscheint mitten in der Fahrt statt am
 * Anfang. Man sieht keinen Sprung — nur, dass es sofort losgeht.
 */
let assistantMoving = false;
/** Läuft Bos Bewegung? Als JS-Wert — Begründung siehe `isDetailsPushStarted`. */
export function isAssistantPushStarted(): boolean {
  return assistantMoving;
}

/**
 * Auch für die Blätter von unten anzumelden — sie haben keinen gemeinsamen
 * Startpunkt wie die Seitwärts-Slides, deshalb hier als eigene Funktion für
 * alle, die eines öffnen oder schließen.
 */
export function markSheetMoving(durationMs: number = SHEET_IN.duration): void {
  markTransitionBusy(durationMs);
}

/**
 * Bos Fahrt gehört in dieselbe Anmeldung wie jedes andere Blatt.
 *
 * `markTransitionBusy` allein reicht nicht: An `isSheetMoving()` hängt der
 * Riegel in `transitionLayer.ts`, der eine GPU-Textur NICHT abreißen lässt,
 * solange etwas fährt. Für Bo galt er nie — eine Textur, die kurz zuvor durch
 * eine Berührung angefordert wurde, konnte also mitten in seiner Fahrt
 * ablaufen und sie anhalten. Genau das „manchmal ruckelt es, manchmal nicht".
 */
/**
 * Was NACH Bos Einfahrt laufen soll — vom Bildschirm einmal hinterlegt.
 *
 * Dasselbe Muster wie beim Such-Blatt (`setSearchHeroArrivedHandler`), und aus
 * demselben Grund: Die Kurve startet im Tipp-Handler des Landingscreens, die
 * Arbeit danach liegt aber im Bildschirm. Ein fester Verteiler statt eines
 * eingefangenen Rückrufs — ein Worklet fängt seine Schließung beim Anlegen ein
 * und sähe eine später gesetzte Funktion nie.
 */
let assistantArrivedCb: (() => void) | null = null;
export function setAssistantArrivedHandler(fn: (() => void) | null): void {
  assistantArrivedCb = fn;
}
function assistantArrived(): void {
  assistantArrivedCb?.();
}

/**
 * Die Fahrt ANMELDEN, bevor sie startet.
 *
 * Bos Öffnung läuft über drei Schritte: Tipp → `openAssistant()` → ein Bild
 * Vorlauf → `startAssistantPush()`. Angemeldet wurde die Bewegung bisher erst
 * im letzten Schritt. Dazwischen liegt ein Bild, in dem `isTransitionBusy()`
 * noch falsch meldet — und auf genau diese Prüfung wartet die halbe App:
 * die Persistenz des Speichers, das Aufräumen des Such-Blattes, die
 * Wiederversuche in
 * Bos eigenem Bildschirm. Alles, was sich aufgeschoben hat, darf in diesem
 * einen Bild landen — und schiebt damit den Vorlauf-Rahmen nach hinten, in dem
 * die Kurve losgehen soll.
 *
 * Das Such-Blatt kennt das Loch nicht: Es startet seine Kurve schon im
 * Berührungs-Bild und meldet damit ab dem ersten Moment Bewegung an. Genau das
 * ist der Grund, warum ausgerechnet Bos Einfahrt die unruhigere der beiden ist.
 *
 * `markTransitionBusy` nimmt immer den späteren Zeitpunkt, die Anmeldung im
 * Kurvenstart bleibt also gültig und überschreibt nichts.
 */
export function armAssistantPush(): void {
  markTransitionBusy(ASSISTANT_IN.duration + 48);
}

export function startAssistantPush(): void {
  markTransitionBusy(ASSISTANT_IN.duration);
  setSheetMoving(true, "assistant");
  assistantMoving = true;
  // Kein Rückwurf auf 0 — siehe `startDetailsPush`.
  assistantPush.value = withTiming(1, ASSISTANT_IN, (finished) => {
    "worklet";
    if (!finished) return;
    runOnJS(setSheetMoving)(false, "assistant");
    /**
     * Und melden, dass der Bildschirm wirklich STEHT.
     *
     * Daran hängt, wann Bo wieder anlaufen darf. Vorher tat das eine Stoppuhr
     * im Bildschirm — und eine Stoppuhr misst ab dem Zeitpunkt, an dem sie
     * gestellt wurde, nicht ab dem Start der Kurve. Zwischen beidem liegen
     * mindestens ein Bild Vorlauf und, bei Last, deutlich mehr. Wird die Fahrt
     * unterbrochen und läuft weiter, stimmt sie ohnehin nicht mehr.
     *
     * Der Abschluss-Rückruf weiß es genau: Er läuft, wenn der Wert sein Ziel
     * erreicht hat.
     */
    runOnJS(assistantArrived)();
  });
}

/**
 * Beim Abbau zurücksetzen — Lage UND Merker.
 *
 * Der Bildschirm hat bisher nur `assistantPush` genullt und den Merker stehen
 * lassen. Wird Bo je auf einem anderen Weg als über `closeScreen` verlassen und
 * danach ohne die übliche Geste geöffnet (Verknüpfung, Wiederherstellung), gilt
 * die Fahrt als „läuft schon" — sie startet also nicht, und der Bildschirm
 * bleibt um eine volle Bildschirmhöhe verschoben liegen. Also unsichtbar.
 */
export function resetAssistantPush(): void {
  assistantMoving = false;
  // Auch abmelden. Wird der Bildschirm mitten in der Fahrt abgebaut, läuft der
  // Abschluss der Kurve nie — der Schlüssel bliebe für den Rest des App-Laufs
  // in der Menge stehen, und daran hängt die Freigabe aller Texturen.
  setSheetMoving(false, "assistant");
  assistantPush.value = 0;
}

/** Gegenbewegung beim Schließen. Der Aufrufer navigiert erst danach zurück. */
export function endAssistantPush(): void {
  markTransitionBusy(ASSISTANT_OUT.duration);
  setSheetMoving(true, "assistant");
  assistantMoving = false;
  assistantPush.value = withTiming(0, ASSISTANT_OUT, (finished) => {
    "worklet";
    if (!finished) return;
    runOnJS(setSheetMoving)(false, "assistant");
  });
}
