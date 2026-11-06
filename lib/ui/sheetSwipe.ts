/**
 * Wegwischen schließt das Blatt — EINMAL, für alle Blätter.
 *
 * „Weg" heißt für ein Blatt von unten: nach unten. Für ein Blatt von OBEN (die
 * Such-Slide der Ergebnisliste) heißt es nach oben, und das ist die EINZIGE
 * Unterscheidung, die diese Datei kennt: `direction` wird zu einem Faktor `dir`
 * aus +1 oder -1, und jede Stelle, an der eine Richtung steckt, multipliziert
 * damit. Kein zweiter Zweig, keine zweite Fassung der Schwellen — sonst hätten
 * wir in einem halben Jahr wieder zwei Gesten, die sich um zehn Punkte und eine
 * Kurve unterscheiden. Genau davon handelt der Rest dieses Kommentars.
 *
 * Für `"down"` ist `dir === 1`, und jede Multiplikation damit ist die Identität:
 * Der bestehende Weg rechnet Zahl für Zahl dasselbe wie vorher.
 *
 * Bis hierher hatte jedes Blatt seine eigene Wisch-Geste, und alle sahen fast
 * gleich aus: `activeOffsetY(8)`, `failOffsetY(-8)`, 110 Punkte oder 700
 * Geschwindigkeit als Abwurf, sonst mit Feder zurück. Fast gleich heißt: Das
 * Verlaufs-Blatt fuhr mit der langen Kurve hinaus, das Ticket-Blatt mit der
 * kurzen, und das Benachrichtigungs-Blatt hatte gar keine. Solche Unterschiede
 * fallen einzeln nicht auf und zusammen sehr wohl.
 *
 * Zwei Dinge macht diese Datei, die die einzelnen Fassungen nicht konnten:
 *
 * **1. Die ganze Fläche ist griffig, nicht nur der Griff.** Die Geste hängt am
 * Blatt selbst, nicht am 40×4 großen Strich oben. Dass ein Tipper auf einen
 * Knopf trotzdem ein Tipper bleibt, entscheidet nicht Code, sondern die
 * Aktivierungs-Schwelle: `activeOffsetY` lässt die Geste erst nach ein paar
 * Punkten Weg anspringen. Bis dahin gehört die Berührung dem Knopf darunter.
 * Springt sie an, nimmt der Erkenner dem Knopf die Berührung ab — der Druck
 * wird abgebrochen, statt beim Loslassen auszulösen. Genau die Entscheidung
 * „Knopf oder Wisch", ohne eine einzige Zeile Heuristik.
 *
 * **2. Eine Liste im Blatt scrollt weiter.** Das ist der Teil, der ohne Hilfe
 * kaputtgeht: Sobald ein Erkenner anspringt, schickt die Gesten-Bibliothek den
 * nativen Ansichten darunter ein Abbruch-Ereignis — die Liste bliebe mitten im
 * Scrollen stehen. Deshalb `useSheetScrollGate`: Die Liste bekommt einen
 * eigenen nativen Erkenner, beide werden als GLEICHZEITIG angemeldet (dann
 * bricht keiner den anderen ab), und der Scroll-Stand entscheidet, wer die
 * Bewegung zeigt. Steht die Liste nicht ganz oben, wandert nur der Nullpunkt
 * mit — das Blatt rührt sich nicht. Erreicht sie oben, übernimmt das Blatt
 * bruchlos.
 *
 * Was hier NICHT hineingehört: Blätter mit Rastpunkten (`StopDetailSheet`,
 * `SurroundingsSheet`). Die haben mehr als „offen oder weg" und behalten ihre
 * eigene Geste; von hier nehmen sie nur die Torhüter-Funktion.
 */
import { useLayoutEffect, useMemo } from "react";
import { Dimensions, PixelRatio } from "react-native";
import { Gesture, type NativeGesture } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue,
  withRepeat,
  withTiming,
  type AnimatedRef,
  type SharedValue,
} from "react-native-reanimated";
import { markSheetMoving } from "@/lib/nav/overlayCover";

/**
 * So weit muss der Finger nach unten, bevor aus einem Druck ein Wisch wird.
 *
 * Der Wert ist die eigentliche Antwort auf „Knopf oder Wisch": klein genug,
 * dass sich das Blatt sofort mitzubewegen scheint, groß genug, dass das
 * unvermeidliche Wackeln beim Antippen keinen Wisch auslöst.
 */
export const SWIPE_ACTIVATE = 8;

/**
 * Deutlich quer = kein Wisch nach unten.
 *
 * Ohne diese Schranke fräße das Blatt die Wisch-zum-Löschen-Geste der Karten im
 * Verlaufs-Blatt: Die springt erst bei 10 Punkten seitlich an, das Blatt schon
 * bei 8 nach unten — bei einer schrägen Bewegung wäre das Blatt regelmäßig
 * zuerst dran. 20 Punkte seitlich vor 8 nach unten ist eine Bewegung, die
 * niemand als „nach unten" gemeint hat.
 */
const FAIL_X = 20;

/** Wisch-Abwurf: kürzer als die reguläre Ausfahrt — der Weg ist schon halb zurückgelegt. */
export const SWIPE_OUT = { duration: 220, easing: Easing.out(Easing.quad) } as const;

/** Ab hier gilt der Wisch als Abwurf: entweder weit genug oder schnell genug. */
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 700;

/**
 * Zurück an den Platz, wenn es für den Abwurf nicht gereicht hat — als KURVE,
 * nicht mehr als Feder.
 *
 * Die Feder hier hatte einen Dämpfungsgrad von rund 0,74 und schwang damit um
 * gut 3% über: Das Blatt fuhr am Ruhepunkt VORBEI, also über seine Oberkante
 * hinaus, und darunter wurde für ein paar Bilder der Hintergrund sichtbar.
 * Genau das ist der „Sprung beim Hochgleiten". Dazu kommt der Anlauf: Eine
 * Feder startet mit Geschwindigkeit null, der Finger war aber gerade noch in
 * Bewegung — nach dem Loslassen lag deshalb erst ein Zögern und dann ein
 * Schnalzen.
 *
 * `Easing.out` startet schnell und läuft aus. Das ist dieselbe Kurve wie beim
 * Abwurf (`SWIPE_OUT`) — beides sind Bewegungen, die der Finger angestoßen hat.
 */
const RETURN_EASE = Easing.out(Easing.quad);
const RETURN_MS = 220;
/**
 * Kurzer Weg, kurze Dauer — sonst kriecht das Blatt über zwei Fingerbreit
 * zurück. Bezugsgröße ist die Abwurf-Entfernung, denn weiter als die kann der
 * Rückweg gar nicht sein: Alles darüber wäre ein Abwurf gewesen.
 */
const RETURN_MIN_FRAC = 0.25;

/**
 * Die Fensterhöhe EINMAL beim Laden — als Notmaß, wenn ein Blatt seine eigene
 * Höhe noch nicht kennt.
 *
 * Hier stand `Dimensions.get("window").height` MITTEN im Worklet des
 * Loslassens. Das ist eine Zeitbombe: `Dimensions` ist ein gewöhnliches
 * JS-Objekt, und ein Aufruf seiner Methode auf dem UI-Strang bricht ab. Nur
 * kam er nie dran — davor steht ein `||`, und die Höhe war bisher immer
 * gesetzt. Beim ersten Blatt, das vor seiner Vermessung weggewischt wird, wäre
 * es ein Absturz gewesen. Als Zahl gelesen ist es harmlos: Zahlen dürfen ins
 * Worklet.
 */
const WINDOW_H = Dimensions.get("window").height;

/**
 * Der Torhüter für eine Liste im Blatt.
 *
 * `native` gehört an einen `GestureDetector` UM die Liste, `onScroll` und
 * `scrollEventThrottle` an die Liste selbst — und die muss dafür eine
 * `Animated.ScrollView` sein, sonst läuft der Scroll-Stand über den JS-Strang
 * und ist genau dann veraltet, wenn er gebraucht wird.
 */
/** Gerätepixel je Punkt — außerhalb der Worklets gelesen, dort nur die Zahl. */
const DEVICE_PX = PixelRatio.get();

/**
 * Die Lage eines Blattes auf GANZE Gerätepixel.
 *
 * Ein Blatt folgt dem Finger in Bruchteilen eines Pixels. Android setzt Schrift
 * senkrecht aber immer auf ganze Pixel, Flächen und Ränder dagegen geglättet
 * dazwischen: Bei jedem Bild sprang die Schrift um ein Pixel gegen ihre Pille,
 * ihre Zeile, ihre Trennlinie. Stand bisher nur im Haltestellen-Blatt und im
 * Auswahlfenster; gilt jetzt für jedes Blatt, das man ziehen kann.
 */
export function snapToPixel(v: number): number {
  "worklet";
  return Math.round(v * DEVICE_PX) / DEVICE_PX;
}

/**
 * Länger hält niemand ein Blatt fest (siehe `DRAG_MAX_MS` in transitionBusy.ts).
 * VOR der Funktion: Das Worklet nimmt die Zahl beim Laden des Moduls mit.
 */
const DRAG_HEAL_HALF_CYCLES = 30;

/**
 * SELBSTKORREKTUR WÄHREND DES ZIEHENS — gegen zurückgeschriebene Lagen.
 *
 * Die App lässt Reanimated Verschiebung und Deckkraft direkt an die Ansichten
 * schreiben, am React-Baum vorbei (`ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS` in
 * package.json). Jeder React-Durchgang IRGENDWO in der App trägt dann die
 * zuletzt bekannten Reanimated-Werte in den Baum ein (`ReanimatedCommitHook`) —
 * und bringt sie erst ein, zwei Bilder später auf den Bildschirm. Fällt er in
 * ein Ziehen, setzt er das Blatt auf eine ältere Lage zurück. Bewegt sich der
 * Finger weiter, korrigiert das nächste Bild; bleibt er LIEGEN, bleibt auch die
 * falsche Lage stehen, bis sich wieder etwas bewegt. Gemeldet als „ziehe ich
 * die Slide runter und lasse den Finger drauf, buggen die Elemente".
 *
 * Das Ticket-Blatt zeigte das nicht, weil dort während des Ziehens nichts
 * rendert. Die übrigen rendern — Gedrückt-Zustände, eintreffende Daten, der
 * Bildschirm dahinter.
 *
 * Deshalb läuft, solange ein Finger auf dem Blatt liegt, dieser Wert ständig
 * zwischen 0 und 1 hin und her. Die Blätter rechnen ihn als Tausendstel Punkt
 * in ihre Lage ein (`dragHealOffset`) — unsichtbar, aber jedes Bild ein
 * anderer Wert. Damit schreibt Reanimated die RICHTIGE Lage in jedem Bild neu,
 * und ein zurückgeschriebener Wert steht höchstens ein Bild. Nach dem Loslassen
 * steht er wieder auf 0; die Ausfahrt oder das Einrasten bewegt das Blatt
 * ohnehin in jedem Bild.
 */
export function startDragHeal(heal: SharedValue<number>): void {
  "worklet";
  // Begrenzt auf 30 halbe Runden (15 s) statt endlos: Bliebe ein Loslassen je
  // unbemerkt, liefe der Puls sonst für immer — und das Blatt würde bei jedem
  // Bild neu geschrieben, auch unter einer ruhenden oder ausrollenden Karte.
  heal.value = withRepeat(
    withTiming(1, { duration: 500, easing: Easing.linear }),
    DRAG_HEAL_HALF_CYCLES,
    true,
  );
}


export function stopDragHeal(heal: SharedValue<number>): void {
  "worklet";
  cancelAnimation(heal);
  heal.value = 0;
}

/** Halbe Runde des Nachschreibens (siehe `settleHeal`) — VOR der Funktion, wie oben. */
const SETTLE_HALF_MS = 250;

/**
 * NACHSCHREIBEN NACH EINER FAHRT — dasselbe Mittel wie `startDragHeal`, für
 * eine feste Zeit statt für die Dauer einer Berührung.
 *
 * Die Lücke, die es schließt: Ein React-Durchgang, der WÄHREND einer Fahrt
 * angestoßen wird, kommt erst ein, zwei Bilder später (bei einem schweren
 * Durchgang auch später) auf den Schirm — mit den Werten von unterwegs. Endet
 * die Fahrt vorher, bewegt sich danach nichts mehr, und die alte Lage bleibt
 * stehen. Am Gerät gesehen (06.11.2026): Haltestellen-Blatt heruntergewischt,
 * das Auswahlfenster dahinter blieb unter dem Rand liegen, obwohl der
 * Standort-Knopf schon richtig darüber stand.
 *
 * `ms` ab jetzt: Fahrt plus Nachlauf. Endet auf dem Ausgangswert (gerade Zahl
 * halber Runden), also auf 0. Eine Berührung ersetzt ihn (`startDragHeal`).
 */
export function settleHeal(heal: SharedValue<number>, ms: number): void {
  "worklet";
  const halves = Math.max(2, 2 * Math.ceil(ms / (2 * SETTLE_HALF_MS)));
  // Von 0 aus — kam er aus einem laufenden Puls, endete er sonst irgendwo
  // dazwischen statt wieder bei 0.
  heal.value = 0;
  heal.value = withRepeat(
    withTiming(1, { duration: SETTLE_HALF_MS, easing: Easing.linear }),
    halves,
    true,
  );
}

/** Der Beitrag zur Lage — ein Tausendstel Punkt, siehe `startDragHeal`. */
export function dragHealOffset(heal: SharedValue<number>): number {
  "worklet";
  return heal.value * 0.001;
}

export interface SheetScrollGate {
  /**
   * Gehört an die Liste (`ref={gate.ref}`) — darüber wird sie festgehalten.
   *
   * **NUR an eine `Animated.ScrollView`, NIEMALS an eine `Animated.FlatList`.**
   * Das ist kein Geschmacksurteil, sondern eine Absturzkette: Reanimated löst
   * aus einem Verweis die native Ansicht auf, indem es der Reihe nach
   * `__internalInstanceHandle`, dann `getNativeScrollRef()` und erst dann
   * `_reactInternals` probiert. Eine `FlatList` hat `getNativeScrollRef()` —
   * damit greift der zweite Zweig, und der dritte wird übersprungen. Nur liefert
   * die Methode über `VirtualizedList.getScrollRef()` die `ScrollView`-KLASSE
   * zurück, nicht die native Ansicht; die hat kein `__internalInstanceHandle`,
   * und die Zeile danach greift ungeprüft darauf zu. Ergebnis: Absturz beim
   * Aufbau. Eine `Animated.ScrollView` reicht denselben Aufruf an die echte
   * native Ansicht durch und geht deshalb gut.
   *
   * Eine `FlatList` benutzt vom Torhüter also nur `scrollY`, `onScroll` und
   * `native` — und regelt das Festhalten über die Bedingung im eigenen Worklet
   * (siehe `SurroundingsSheet`).
   */
  ref: AnimatedRef<Animated.ScrollView>;
  scrollY: SharedValue<number>;
  /**
   * Liegt der Finger gerade AUF der Liste?
   *
   * Ohne diese Angabe war der Torhüter blind für die Stelle der Berührung — er
   * las nur den Scroll-Stand. Eine gescrollte Liste sperrte damit das ganze
   * Blatt: Man zog am Griff, an den Reitern, an der Überschrift, und nichts
   * rührte sich, weil irgendwo darunter eine Liste nicht auf Anschlag stand.
   * Am Umgebungs-Blatt hieß das „lässt sich manchmal gar nicht aufziehen"; es
   * half nur, die Liste über einen Kategorie-Wechsel auf Null zu setzen.
   *
   * Die Angabe kommt vom nativen Erkenner der Liste selbst: Der bekommt eine
   * Berührung nur, wenn sie auch auf ihr landet.
   */
  onList: SharedValue<boolean>;
  onScroll: ReturnType<typeof useAnimatedScrollHandler>;
  native: NativeGesture;
}

export function useSheetScrollGate(): SheetScrollGate {
  const ref = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useSharedValue(0);
  const onList = useSharedValue(false);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
  // Fest — ein neues Gesten-Objekt zwingt den Erkenner, sich bei jedem
  // Durchgang neu gegen seinen nativen Gegenpart einzurichten.
  const native = useMemo(
    () =>
      Gesture.Native()
        // `onBegin` läuft beim Aufsetzen des Fingers, also VOR dem Anspringen
        // der Zieh-Geste (die wartet acht Punkte). Der Wert steht damit
        // rechtzeitig.
        .onBegin(() => {
          onList.value = true;
        })
        .onFinalize(() => {
          onList.value = false;
        }),
    [onList],
  );
  /**
   * Als FESTES Objekt zurück, nicht als frisches bei jedem Durchgang.
   *
   * Die Blätter mit Rastpunkten legen ihre Geste in einem `useMemo` an und
   * führen den Torhüter in dessen Abhängigkeiten — mit einem neuen Objekt pro
   * Durchgang entstünde die Geste also jedes Mal neu, und der Erkenner müsste
   * sich gegen seinen nativen Gegenpart neu einrichten. Beide Dateien warnen
   * genau davor: Das Haltestellen-Blatt rendert im Sekundentakt (Ticker für die
   * Abfahrtszeiten), das Umgebungs-Blatt bei jeder Kartenbewegung.
   *
   * Alle fünf Teile sind für sich schon fest — es fehlte nur die Hülle.
   */
  return useMemo(
    () => ({ ref, scrollY, onList, onScroll, native }),
    [ref, scrollY, onList, onScroll, native],
  );
}

/**
 * Zurück an den Ruhepunkt — auf dem UI-Strang, im selben Bild wie das
 * Loslassen.
 *
 * Angemeldet wird die Rückkehr trotzdem: An `markSheetMoving` hängt der Riegel,
 * der eine GPU-Textur nicht mitten in einer Fahrt abreißen lässt. Ohne ihn
 * konnte genau diese kurze Kurve von einem fremden Commit angehalten werden —
 * das „manchmal ruckelt es, manchmal nicht" aus `overlayCover`.
 */
function settleBack(y: SharedValue<number>, rest: number) {
  "worklet";
  const dist = Math.abs(y.value - rest);
  if (dist < 0.5) {
    y.value = rest;
    return;
  }
  const frac = Math.min(1, Math.max(RETURN_MIN_FRAC, dist / DISMISS_DISTANCE));
  const duration = Math.round(RETURN_MS * frac);
  runOnJS(markSheetMoving)(duration);
  y.value = withTiming(rest, { duration, easing: RETURN_EASE });
}

export interface SheetSwipeOptions {
  /** Die Lage des Blattes — derselbe geteilte Wert, den auch die Einfahrt schreibt. */
  y: SharedValue<number>;
  /**
   * Der Weg aus dem Bild: die Höhe des Blattes. Immer POSITIV, auch bei
   * `direction: "up"` — die Richtung steht dort und nur dort.
   */
  travel: SharedValue<number> | number;
  /**
   * Läuft auf dem JS-Strang, sobald der Wisch als Abwurf gilt.
   *
   * Bekommt die Dauer der Ausfahrt mit, damit der Aufrufer das Abmelden
   * dahinter legen kann — Blätter in einem Fenster verschwinden sonst
   * schlagartig, weil mit `visible` auch die Fläche weg ist.
   */
  onDismiss: (durationMs: number, fromY: number) => void;
  /**
   * `true` = die Geste fährt die Ausfahrt selbst, sofort, auf dem UI-Strang.
   *
   * `false` für Blätter, deren Ausfahrt woanders hängt (ein Effekt am `open`,
   * die gemeinsame Fahrt in `useSheetSlide`). Zwei Kurven auf demselben Wert
   * sind sichtbar: Sie überschreiben sich gegenseitig und ergeben mitten in der
   * Bewegung einen Tempo-Wechsel.
   */
  drive?: boolean;
  enabled?: boolean;
  /** Die Ruhelage, falls sie nicht 0 ist. */
  rest?: number;
  /** Liste im Blatt — siehe `useSheetScrollGate`. */
  gate?: SheetScrollGate | null;
  /**
   * Wohin das Blatt weggewischt wird. Vorgabe `"down"` — alle Blätter von
   * unten.
   *
   * `"up"` gilt für ein Blatt, das von OBEN hereinfährt und dessen Parkplatz
   * damit über dem Bildrand liegt (`y < rest`). Gedreht wird daran alles, was
   * eine Richtung kennt: die Aktivierungs-Schwelle, die Seite, auf der die
   * Bewegung überhaupt Platz hat, die Auswertung von Weg und Schwung beim
   * Loslassen und das Vorzeichen der Ausfahrt. `travel` bleibt in BEIDEN Fällen
   * eine positive Länge — es ist der Weg aus dem Bild, nicht ein Ziel.
   */
  direction?: "down" | "up";
  /**
   * Die Selbstkorrektur des Blattes (siehe `startDragHeal`) — die Geste stößt
   * sie beim Aufsetzen an und hält sie beim Loslassen an. Das Blatt rechnet sie
   * über `dragHealOffset` in seine Lage ein.
   */
  heal?: SharedValue<number> | null;
  /**
   * `true` = das Blatt wird gerade von woanders geschlossen (Zurück-Taste,
   * Verdunkelung angetippt). Siehe `released` unten.
   *
   * Als geteilter Wert, wenn der Besitzer seine Ausfahrt SELBST startet: Er
   * setzt ihn davor, beide Schreibvorgänge kommen in dieser Reihenfolge auf dem
   * UI-Strang an. Als Wahrheitswert (`!open`), wenn die Ausfahrt in einem Effekt
   * am Offen-Sein hängt — der wird hier im Layout-Effekt gespiegelt, also vor
   * jedem gewöhnlichen Effekt desselben Durchgangs.
   */
  closing?: SharedValue<boolean> | boolean | null;
}

export function useSheetSwipe({
  y,
  travel,
  onDismiss,
  drive = true,
  enabled = true,
  rest = 0,
  gate = null,
  direction = "down",
  heal = null,
  closing = null,
}: SheetSwipeOptions) {
  /**
   * `closing` als Wahrheitswert, gespiegelt auf den UI-Strang — im
   * Layout-Effekt, also vor dem Effekt, der die Ausfahrt anstößt (über
   * `useSheetSlide` sogar erst ein Bild später).
   *
   * NICHT `enabled`: Das schalten Besitzer auch aus anderen Gründen ab (die
   * Such-Slide etwa, wenn ihr Formular an die Höhengrenze stößt). Galt jedes
   * Abschalten als „wird geschlossen", blieb ein Blatt, dem mitten im Ziehen
   * die Geste abgeschaltet wurde, halb gezogen stehen.
   */
  const closingFlag = useSharedValue(typeof closing === "boolean" ? closing : false);
  /**
   * Hat DIESE Geste das Blatt weggewischt? Gesetzt auf dem UI-Strang im Bild
   * des Loslassens — der Besitzer erfährt es erst über `onDismiss` auf dem
   * JS-Strang, und in diesem Fenster (50–200 ms unter Last) konnte ein neuer
   * Griff die Ausfahrt abbrechen. Zurückgesetzt, sobald das Blatt wieder offen
   * ist (`closing` wird falsch) — Blätter mit eigenem Merker werden je Öffnen
   * neu aufgebaut.
   */
  const dismissed = useSharedValue(false);
  useLayoutEffect(() => {
    if (typeof closing === "boolean") {
      closingFlag.value = closing;
      if (!closing) dismissed.value = false;
    }
  }, [closing, closingFlag, dismissed]);
  const closingSv = typeof closing === "boolean" ? closingFlag : closing;
  /**
   * Der Nullpunkt der Bewegung.
   *
   * Zwei Aufgaben, beide dagegen, dass das Blatt springt: Beim Anspringen steht
   * der Weg schon bei `SWIPE_ACTIVATE` — ohne Abzug hüpfte das Blatt zum Start
   * um diese acht Punkte. Und solange die Liste scrollt, wandert der Nullpunkt
   * MIT, sonst schnellte das Blatt in dem Moment, in dem die Liste oben
   * ankommt, um die ganze Scroll-Strecke nach unten.
   */
  const base = useSharedValue(0);
  /**
   * Wo das Blatt beim Zupacken stand.
   *
   * Vorher wurde von der Ruhelage aus gerechnet. Wer ein Blatt anfasste, das
   * gerade fuhr — die Rückkehr nach einem halben Wisch, die Einfahrt —, riss es
   * damit im ersten Bild an den Ruhepunkt. Jetzt wird die laufende Kurve
   * angehalten und dort weitergemacht, wo sie steht.
   */
  const startY = useSharedValue(0);
  /**
   * Ist die Geste in DIESER Berührung überhaupt angesprungen?
   *
   * `onFinalize` läuft auch für Berührungen, die nie eine Geste wurden — also
   * für jeden Tipper auf einen Knopf im Blatt. Ohne diesen Merker holte der
   * Abbruch-Zweig darin das Blatt an die Ruhelage: Wer während der EINFAHRT
   * irgendwo hintippte, riss sie damit ab, und das Blatt sprang sofort an sein
   * Ziel. Genau der Sprung, den wir gerade an drei anderen Stellen beseitigt
   * haben.
   */
  const active = useSharedValue(false);

  /**
   * Die ganze Richtungs-Information dieser Datei — eine Zahl.
   *
   * Sie zeigt vom Ruhepunkt WEG, also dorthin, wo das Blatt verschwindet. Alles
   * darunter rechnet in dieser gedrehten Achse: „weiter weg als" wird zu
   * `(y - rest) * dir > …`, „nicht über den Ruhepunkt hinaus" zu einem
   * Maximum in derselben Achse, und die Ausfahrt bekommt ihr Vorzeichen
   * schlicht als Faktor.
   */
  const dir = direction === "up" ? -1 : 1;

  const travelSv = typeof travel === "number" ? null : travel;
  const travelConst = typeof travel === "number" ? travel : 0;
  const scrollY = gate?.scrollY ?? null;
  const onList = gate?.onList ?? null;
  const scrollRef = gate?.ref ?? null;
  const nativeScroll = gate?.native ?? null;

  return useMemo(() => {
    /**
     * Hat jemand anderes das Blatt übernommen — schließt es gerade von woanders
     * (`closing`)?
     *
     * Dann schreibt die Geste nichts mehr. Wer das Blatt festhielt und dabei
     * die Zurück-Taste drückte, bekam sonst im nächsten Bild die Lage des
     * Fingers zurückgeschrieben — das brach die Ausfahrt ab, und beim Loslassen
     * rastete ein logisch geschlossenes Blatt wieder ein. Schaltet der Besitzer
     * dabei `enabled` ab, bricht die Geste zudem ab, und der Abbruch-Zweig
     * holte das Blatt mitten in der Ausfahrt an die Ruhelage.
     */
    const released = () => {
      "worklet";
      return dismissed.value || (closingSv !== null && closingSv.value);
    };
    const g = Gesture.Pan()
      .enabled(enabled)
      .activeOffsetY(SWIPE_ACTIVATE * dir)
      // Zur GEGENSEITE sofort aufgeben: Dort liegt entweder eine Liste, die
      // scrollen will, oder schlicht nichts, was das Blatt tun könnte. Bei
      // einem Blatt von oben sind beide Seiten getauscht — es springt auf acht
      // Punkte nach oben an und gibt nach unten auf.
      .failOffsetY(-SWIPE_ACTIVATE * dir)
      .failOffsetX([-FAIL_X, FAIL_X])
      // Selbstkorrektur ab dem Aufsetzen — siehe `startDragHeal`.
      .onBegin(() => {
        if (heal !== null) startDragHeal(heal);
      })
      .onStart((e) => {
        // Ein Blatt, das gerade geschlossen wird, lässt sich nicht fangen — die
        // Ausfahrt bleibt, `active` auch (kein Zurückholen im Abbruch).
        if (released()) return;
        active.value = true;
        // Eine laufende Kurve anhalten und von dort weitermachen — sonst reißt
        // das Zupacken das Blatt im ersten Bild an den Ruhepunkt.
        cancelAnimation(y);
        startY.value = y.value;
        base.value = e.translationY;
      })
      .onUpdate((e) => {
        if (!active.value || released()) return;
        /**
         * Wer die Bewegung zeigt, entscheidet die LAGE des Blattes zuerst.
         *
         * Vorher entschied allein der Scroll-Stand — und das war der Sprung
         * beim Hochziehen: Ein Blatt, das schon 60 Punkte tief hing, wurde in
         * dem Moment, in dem die Liste zu scrollen begann, in EINEM Bild an
         * seinen Platz zurückgerissen. Die Liste fing aber genau dann an zu
         * scrollen, wenn der Finger wieder nach oben ging.
         *
         * Jetzt gilt: Solange das Blatt von seinem Platz weg ist, gehört ihm
         * die Geste — es folgt dem Finger bis zurück an die Ruhelage. Erst wenn
         * es dort liegt UND die Liste scrollt, übernimmt sie.
         *
         * ACHTUNG, FÜR EIN BLATT VON OBEN GILT DIESER TORHÜTER NICHT.
         *
         * Der Satz oben lässt sich nicht einfach spiegeln, und der Grund ist
         * eine Asymmetrie im Scrollen selbst: Die Frage lautet immer „kann die
         * Liste in die gewischte Richtung noch weiter?", und die Antwort steht
         * an ihrem jeweiligen ANSCHLAG. Bei einem Blatt von unten wischt man
         * nach unten, der Anschlag dafür ist der ANFANG der Liste — und den
         * kennt `scrollY` genau, er ist die Null. Bei einem Blatt von oben
         * wischt man nach oben, und der Anschlag dafür ist das ENDE der Liste.
         * Das steht nicht im Scroll-Stand; dafür bräuchte es zusätzlich die
         * Inhalts- und die Sichtfeldhöhe.
         *
         * Mit `scrollY > 0.5` beantwortet man dort also die falsche Frage: Eine
         * Liste, die ganz oben steht, hätte nach unten den ganzen Inhalt vor
         * sich — und bekäme die Geste trotzdem weggenommen. Wer das braucht,
         * führt hier `contentSize` und `layoutMeasurement` mit und prüft gegen
         * das Ende, statt diese Zeile umzudeuten.
         *
         * Die eine Aufrufstelle mit `direction: "up"` (die Such-Slide der
         * Ergebnisliste) übergibt deshalb GAR KEINEN Torhüter: Ihr Formular
         * passt in das Blatt und scrollt nicht. Läuft es doch einmal gegen den
         * Deckel, schaltet sie die ganze Geste ab, statt sie zu raten.
         *
         * `(y - rest) * dir <= 0.5` ist dabei dieselbe Aussage wie vorher
         * `y <= rest + 0.5` — „nicht nennenswert vom Platz weg" —, nur in der
         * gedrehten Achse gemessen.
         */
        const listOwns =
          scrollY !== null &&
          // Nur wenn der Finger auch auf der Liste liegt — siehe `onList`.
          onList !== null &&
          onList.value &&
          (y.value - rest) * dir <= 0.5 &&
          scrollY.value > 0.5;
        if (listOwns) {
          // Der Nullpunkt wandert mit, damit das Blatt nicht später um die
          // ganze Scroll-Strecke nachspringt.
          base.value = e.translationY;
          startY.value = rest;
          return;
        }
        /**
         * Nur zur Wisch-Seite — zur Gegenseite hat das Blatt keinen Platz.
         *
         * Die Begrenzung ist für ein Blatt von unten eine UNTERgrenze und für
         * eines von oben eine OBERgrenze. Statt zwei Zweigen wird in die
         * gedrehte Achse gerechnet, dort begrenzt und zurückgedreht: Für
         * `dir === 1` steht buchstäblich `Math.max(rest, next)` da, für
         * `dir === -1` fällt daraus `Math.min(rest, next)`.
         */
        const next = startY.value + e.translationY - base.value;
        y.value = Math.max(rest * dir, next * dir) * dir;
        /**
         * Liste festhalten, solange das Blatt hängt.
         *
         * Ohne das scrollte sie unter dem gezogenen Blatt mit — sie bekommt
         * dieselbe Berührung ab (beide sind als gleichzeitig angemeldet). Man
         * zieht das Blatt hinunter, lässt es zurückschnappen, und die Liste
         * steht plötzlich woanders.
         */
        if (
          scrollRef !== null &&
          // „Hängt das Blatt gerade?" — in der gedrehten Achse gemessen.
          (y.value - rest) * dir > 0.5 &&
          // NUR wenn sie wirklich weggelaufen ist. Vorher ging in JEDEM Bild
          // eines Zuges ein nativer Scroll-Befehl hinaus, auch wenn die Liste
          // längst oben stand — Arbeit ohne jede Wirkung, und zwar genau
          // während der Bewegung.
          scrollY !== null &&
          scrollY.value > 0.5 &&
          // Nicht jedes Blatt zeigt immer eine Liste (Ladezustand, leerer
          // Zustand). Ohne die Prüfung schriebe Reanimated eine Warnung.
          scrollRef()
        ) {
          scrollTo(scrollRef, 0, 0, false);
        }
      })
      .onEnd((e) => {
        if (!active.value || released()) return;
        /**
         * Gemessen wird der Weg des FINGERS, nicht der Abstand des Blattes zur
         * Ruhelage.
         *
         * Beides ist im Normalfall dasselbe — nicht aber, wenn man ein Blatt
         * anfasst, das gerade HEREINfährt. Es steht dann weit von seiner
         * Ruhelage entfernt, und mit dem alten Maß galt schon das bloße
         * Loslassen als Abwurf: Blatt angetippt, während es kam, und es ging
         * wieder zu.
         */
        // Positiv heißt IMMER „in Wisch-Richtung" — bei einem Blatt von oben
        // ist das ein negativer Finger-Weg. Die Schwellen darunter bleiben
        // dadurch dieselben Zahlen für beide Richtungen.
        const dy = (e.translationY - base.value) * dir;
        /**
         * Der Schwung allein wirft nur ein Blatt ab, das auch WIRKLICH hängt.
         *
         * Sonst schlösse ein kräftiger Wisch IN der Liste das Blatt: Der
         * Erkenner läuft dabei mit (beide sind als gleichzeitig angemeldet),
         * bewegt nichts — und läse am Ende trotzdem die Geschwindigkeit des
         * Listen-Wischs als Abwurf.
         */
        const displaced = (y.value - rest) * dir > 0.5;
        if (dy > DISMISS_DISTANCE || (displaced && e.velocityY * dir > DISMISS_VELOCITY)) {
          if (drive) {
            /**
             * Die Bewegung SOFORT von hier, auf dem UI-Strang.
             *
             * Der Finger ist gerade erst weg; ein Umweg über den JS-Strang
             * liegt genau dazwischen und ist als kurzes Stocken zu spüren —
             * dieselbe Stelle, an der die Schublade des Bo-Screens hakte.
             * Wer `drive: false` setzt, MUSS die Ausfahrt anderswo im selben
             * Bild anstoßen; sonst ist genau dieses Stocken wieder da.
             */
            // `travel` ist eine LÄNGE, kein Ziel — das Vorzeichen kommt aus der
            // Richtung. Ein Blatt von oben fährt nach `-dist` hinaus.
            const dist = (travelSv ? travelSv.value : travelConst) || WINDOW_H;
            y.value = withTiming(dist * dir, SWIPE_OUT);
            // Anmelden wie jede andere Fahrt: An `markSheetMoving` hängt der
            // Riegel, der eine GPU-Textur nicht mitten in der Bewegung
            // abreißen lässt.
            runOnJS(markSheetMoving)(SWIPE_OUT.duration);
          }
          // Nur mit `closing`: Ohne ihn gäbe es nichts, was den Merker beim
          // nächsten Öffnen zurücksetzt — die Geste wäre danach tot.
          if (closingSv !== null) dismissed.value = true;
          runOnJS(onDismiss)(SWIPE_OUT.duration, y.value);
          return;
        }
        settleBack(y, rest);
      })
      /**
       * Auch der ABBRUCH gehört zurückgeholt.
       *
       * Springt mitten im Ziehen ein anderer Erkenner an, kommt kein `onEnd` —
       * das Blatt bliebe schief stehen, wo der Finger es gelassen hat.
       */
      .onFinalize((_e, success) => {
        /**
         * Den Finger-auf-der-Liste-Merker beim ENDE der Berührung löschen, nicht
         * erst beim Beginn der nächsten.
         *
         * Der native Erkenner der Liste tut das selbst — aber nur, wenn es ihn
         * beim Loslassen noch gibt. Wird die Liste mitten in einer Berührung
         * abgebaut (Ladezustand, Datenwechsel), bliebe der Merker auf „ja"
         * stehen, und die Liste beanspruchte danach jede Geste. Hier ist die
         * Reihenfolge unkritisch: Die nächste Berührung setzt ihn ohnehin neu,
         * bevor diese Geste anspringt.
         */
        if (onList !== null) onList.value = false;
        if (heal !== null) stopDragHeal(heal);
        const wasActive = active.value;
        active.value = false;
        // Nur was angesprungen ist, gehört auch zurückgeholt — siehe `active`.
        if (success || !wasActive || released()) return;
        if (y.value !== rest) settleBack(y, rest);
      });

    // Gleichzeitig mit der Liste: Sonst bricht das Anspringen der einen die
    // andere ab — siehe Kopf der Datei.
    return nativeScroll ? g.simultaneousWithExternalGesture(nativeScroll) : g;
  }, [
    active,
    base,
    startY,
    closingSv,
    dismissed,
    dir,
    drive,
    enabled,
    heal,
    nativeScroll,
    onDismiss,
    onList,
    rest,
    scrollRef,
    scrollY,
    travelConst,
    travelSv,
    y,
  ]);
}
