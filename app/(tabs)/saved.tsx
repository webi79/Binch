import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Platform,
  View,
  Text,
  ScrollView,
  FlatList,
  SectionList,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import type { SavedTrip, Ticket } from "@/types/saved";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIsFocused } from "@react-navigation/native";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore, type SearchStoreState } from "@/stores/searchStore";
import { ResultCard } from "@/components/results/ResultCard";
import { TicketCard } from "@/components/saved/TicketCard";
import { AddTicketModal } from "@/components/saved/AddTicketModal";
import { EmptyState } from "@/components/saved/EmptyState";
import { AddTicketButton } from "@/components/saved/AddTicketButton";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { GUTTER, SPACE, HEADING_TOP, HEADING_GAP, useNavbarSpace } from "@/lib/theme/spacing";
import { ScreenHeading } from "@/components/ui/ScreenHeading";
import { SlidingPanels } from "@/components/ui/SlidingPanels";
import { useAccent } from "@/lib/theme/accent";
import { useAppBg } from "@/lib/theme/appBg";
import { overlayCover, UNDERLAY_TRAVEL_FRAC } from "@/lib/nav/overlayCover";
import { subscribeLayer, releaseLayer } from "@/lib/nav/transitionLayer";

/**
 * Subscribe-only-when-focused. Subscribt nur an `useSearchStore` wenn
 * `isFocused` true ist — andere Tabs sind permanent gemountet (native
 * bottom tabs), und ihre Store-Subscriptions würden sonst bei jedem Save
 * für unsichtbare Tabs feuern und Re-Renders triggern.
 */
/**
 * Als MODUL-Funktion, nicht als frische Schließung im JSX.
 *
 * Der Handler sitzt auf einem animierten Knoten. Eine neue Funktions-Kennung
 * pro Durchgang ist dort dasselbe wie ein neues Stil-Objekt: ein Fabric-Commit
 * auf genau der Ansicht, die Reanimated Bild für Bild beschreibt. `releaseLayer`
 * braucht nur einen festen Schlüssel — die Funktion kann also einmal existieren.
 */
function releaseSavedLayer(): void {
  releaseLayer("saved");
}

function useFocusedStoreSnapshot<T>(
  isFocused: boolean,
  selector: (s: SearchStoreState) => T,
): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const [value, setValue] = useState<T>(() =>
    selectorRef.current(useSearchStore.getState()),
  );
  useEffect(() => {
    if (!isFocused) return;
    // Sofort Snapshot ziehen — die Tab könnte mit veralteten Daten gerade
    // fokussiert worden sein.
    setValue(selectorRef.current(useSearchStore.getState()));
    let prev = selectorRef.current(useSearchStore.getState());
    const unsub = useSearchStore.subscribe((state) => {
      const next = selectorRef.current(state);
      if (next !== prev) {
        prev = next;
        setValue(next);
      }
    });
    return unsub;
  }, [isFocused]);
  return value;
}

type Tab = "trips" | "tickets";

/**
 * Trägt den Parallax-Transform — und für die Dauer eines Übergangs eine
 * GPU-Textur.
 *
 * Eigene Komponente, damit der Zustandswechsel beim Fingerdruck NUR diesen
 * Knoten neu rendert. Läge er im Tab selbst, rendete dessen kompletter Baum im
 * Berührungs-Frame neu — genau die Sorte Arbeit, die dieser Übergang vermeiden
 * soll. Die Kinder kommen unverändert von außen und bleiben stehen.
 */
function ParallaxLayer({
  style,
  children,
}: {
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const [layered, setLayered] = useState(false);
  useEffect(() => subscribeLayer("saved", setLayered), []);
  return (
    <Animated.View
      style={style}
      renderToHardwareTextureAndroid={Platform.OS === "android" && layered}
      collapsable={false}
    >
      {children}
    </Animated.View>
  );
}

function isToday(timestamp: number): boolean {
  const now = new Date();
  const d = new Date(timestamp);
  return (
    now.getFullYear() === d.getFullYear() &&
    now.getMonth() === d.getMonth() &&
    now.getDate() === d.getDate()
  );
}

export default function SavedScreen() {
  const t = useT();
  const accent = useAccent();
  const appBg = useAppBg();
  const [tab, setTab] = useState<Tab>("trips");
  const [showModal, setShowModal] = useState(false);
  const isFocused = useIsFocused();
  const navbarSpace = useNavbarSpace();
  /**
   * Die Innenabstände der drei Listen EINMAL, nicht pro Durchgang.
   *
   * Als Literal im JSX ist jedes davon bei jedem Rendern ein frisches Objekt —
   * und damit ein geänderter Stil-Prop auf dem Scroll-Container, den Fabric
   * committen muss. Dieser Bildschirm rendert bei jedem Reiter-Wechsel, jedem
   * Speichern und jeder Rückkehr neu; die Zahl darin ändert sich dabei nie.
   */
  const padBottom = useMemo(() => ({ paddingBottom: navbarSpace }), [navbarSpace]);
  const padBottomGutter = useMemo(
    () => ({ paddingBottom: navbarSpace, paddingHorizontal: GUTTER }),
    [navbarSpace],
  );
  /**
   * Beim Betreten den roten Punkt löschen.
   *
   * Nicht beim Verlassen und nicht per Zeitgeber: Er bedeutet „seit deinem
   * letzten Blick ist etwas dazugekommen", und der Blick ist genau dieser
   * Moment. Der Store-Aufruf prüft selbst, ob überhaupt etwas zu löschen ist —
   * sonst liefe bei JEDEM Fokus ein Schreibvorgang durch den Speicher.
   */
  const clearSavedBadge = useSearchStore((st) => st.clearSavedBadge);
  useEffect(() => {
    if (isFocused) clearSavedBadge();
  }, [isFocused, clearSavedBadge]);

  // Parallax: dieser Screen wandert ein Stück mit, während das
  // TicketDetailOverlay darüber reinslidet (nur DIESER Baum wird transformiert).
  //
  // Hier stand lange „BEWUSST ohne renderToHardwareTextureAndroid: Der Layer-Flip
  // erzwang ein 66ms-Record-View#draw() über den ganzen Tree (Perfetto)". Der
  // Befund stimmt — die Schlussfolgerung war nur unvollständig. Ohne Textur wird
  // dieser Baum in JEDEM Bild der Bewegung neu gezeichnet; die Messung am
  // Ticket-Blatt beziffert das mit ~14,7ms gegen ein 8,3ms-Budget, also fällt
  // jedes zweite Bild aus. Genau das ist das Ruckeln der Unterlage.
  //
  // Der Widerspruch löst sich über den ZEITPUNKT: Die 66ms entstanden, weil die
  // Ebene eingeschaltet wurde, als die Animation schon lief. Sie wird jetzt beim
  // Fingerdruck auf die Karte vorbereitet (siehe transitionLayer) — da ist Zeit
  // dafür, und danach ist ein Bild nur noch ein Kopiervorgang.
  const { width: screenW } = useWindowDimensions();
  /**
   * Nur ausweichen, wenn dieser Reiter überhaupt zu sehen ist.
   *
   * Der Parallax-Wert ist geteilt: Ihn treibt jedes Detail-Blatt, auch das aus
   * der Ergebnisliste. Der Saved-Reiter bleibt aber dauerhaft gemountet (native
   * Bottom-Tabs, siehe direkt darunter) — er bekam also bei JEDER Slide im
   * Ergebnis-Bildschirm in jedem Bild einen Transform geschrieben, obwohl ihn
   * niemand sieht. Ein vollflächiger Auswerter pro Bild, für nichts.
   *
   * Die Abfrage steht IM Worklet-Aufbau, nicht darin: Ist der Reiter nicht
   * fokussiert, liest das Worklet den geteilten Wert gar nicht erst — und was
   * nicht gelesen wird, wird auch nicht abonniert. Der Auswerter läuft dann
   * überhaupt nicht mit.
   */
  const parallaxStyle = useAnimatedStyle(
    () =>
      isFocused
        ? { transform: [{ translateX: overlayCover.value * screenW * UNDERLAY_TRAVEL_FRAC }] }
        : NO_PARALLAX,
    [isFocused, screenW],
  );

  // Native-Bottom-Tabs halten die Saved-Tab IMMER mounted (auch wenn der
  // User auf Home ist). Mit `useSearchStore((s) => s.savedTrips)` würde
  // diese Komponente bei JEDEM Save re-rendern — useMemo-Filter neu laufen
  // lassen, SectionList reconcilen — obwohl der User die Tab gar nicht
  // sieht. Das ist UI-Thread- und JS-Thread-Arbeit die Landing-Scroll
  // und Tab-Switches stuttern lässt.
  //
  // Lösung: NUR subscriben wenn fokussiert. Sonst lesen wir den letzten
  // bekannten Stand aus dem Ref und rendern den. Beim Re-Focus wird der
  // Ref aktualisiert und wir re-rendern einmalig.
  const savedTripsSnapshot = useFocusedStoreSnapshot(
    isFocused,
    (s) => s.savedTrips,
  );
  const ticketsSnapshot = useFocusedStoreSnapshot(
    isFocused,
    (s) => s.tickets,
  );
  const savedTrips = savedTripsSnapshot;
  const tickets = ticketsSnapshot;
  const addTicket = useSearchStore.getState().addTicket;

  // Früher stand hier ein Skelett, das beim ERSTEN Besuch 220ms lang anstelle
  // der echten Karten lief — damit sich nicht alle gleichzeitig im Wechsel-Frame
  // vermessen. Dieser Frame gehört ihnen inzwischen gar nicht mehr: Mit
  // lazy={false} (siehe _layout.tsx) entsteht der Tab schon beim App-Start,
  // hinter der Splash. Das Skelett hätte also nur noch genau den sichtbaren
  // Umbau beigesteuert, den es eigentlich verhindern sollte.

  const today = useMemo(() => savedTrips.filter((tr) => isToday(tr.savedAt)), [savedTrips]);
  const earlier = useMemo(() => savedTrips.filter((tr) => !isToday(tr.savedAt)), [savedTrips]);

  /**
   * Beide Listen sind jetzt VIRTUALISIERT — vorher `.map()` in einer ScrollView.
   *
   * Damit lagen bei 30 gespeicherten Reisen 30 vollständige `ResultCard`s im
   * Baum, jede mit eigenem Reanimated-Stil und zwei Store-Abos. Und sie lagen
   * dort DAUERHAFT: Der Reiter bleibt gemountet, auch wenn man ihn nie öffnet.
   * Aufgebaut wurde alles gemeinsam im Bild des Reiter-Wechsels.
   *
   * Schwerer wiegt der zweite Fall: Beim Öffnen eines Tickets ist genau diese
   * Fläche die Unterlage, die mitwandert — und über ihr liegt für die Dauer der
   * Bewegung eine GPU-Textur. Deren Aufbau kostet einmalig, und er kostet umso
   * mehr, je größer der Baum darunter ist. Die Kosten skalierten also mit der
   * Zahl gespeicherter Reisen; genau deshalb wurde die Slide „mit der Zeit
   * schlechter".
   */
  const tripSections = useMemo(
    () =>
      [
        ...(today.length > 0 ? [{ key: "today", title: t("saved.section.today"), data: today }] : []),
        ...(earlier.length > 0
          ? [{ key: "earlier", title: t("saved.section.earlier"), data: earlier }]
          : []),
      ],
    [today, earlier, t],
  );
  const renderTrip = useCallback(
    ({ item }: { item: SavedTrip }) => (
      <View style={rowGap}>
        <ResultCard result={item} passengers={item.passengers} underlay="saved" />
      </View>
    ),
    [],
  );
  const renderTripSection = useCallback(
    ({ section }: { section: { title: string } }) => (
      <Text className="text-[15px] font-semibold text-white mt-1 mb-2.5">{section.title}</Text>
    ),
    [],
  );
  const tripKey = useCallback((item: SavedTrip) => item.id, []);
  const renderTicket = useCallback(
    ({ item }: { item: Ticket }) => <TicketCard ticket={item} />,
    [],
  );
  const ticketKey = useCallback((item: Ticket) => item.id, []);
  const openAddTicket = useCallback(() => setShowModal(true), []);

  const ticketCountKey = tickets.length === 1 ? "saved.tickets.count.one" : "saved.tickets.count.many";
  const ticketCountLine = t(ticketCountKey).replace("{count}", String(tickets.length));

  // Keine gestaffelte Einblend-Welle mehr — siehe Landingscreen.
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: appBg }} edges={["top"]}>
      <ParallaxLayer style={[{ flex: 1 }, parallaxStyle]}>
      {/* Titel = Chrome, bleibt stehen (siehe Home). Abstände über das geteilte
          Raster — dieser Screen ist die Vorlage, an der die anderen ausgerichtet
          sind (siehe HEADING_TOP/HEADING_GAP in lib/theme/spacing.ts). */}
      <View style={{ paddingHorizontal: GUTTER, paddingTop: HEADING_TOP }}>
        <ScreenHeading>Saved</ScreenHeading>
      </View>

      <View
        style={{
          paddingHorizontal: GUTTER,
          paddingTop: HEADING_GAP,
          paddingBottom: SPACE.lg,
        }}
      >
        <SegmentedToggle
          items={[
            { id: "trips", label: t("saved.tab.trips") },
            { id: "tickets", label: t("saved.tab.tickets") },
          ]}
          selectedId={tab}
          onChange={(id) => setTab(id as Tab)}
          borderRadius={16}
          segmentHeight={36}
        />
      </View>

      {/* Pager-Style Slide — beide Panels in EINEM breiten Container, der
          als Ganzes translateX'd wird. Wirkt wie eine durchgehende
          horizontale Scroll-Surface (Shazam-Style), nicht wie zwei
          unabhängige Slides. */}
      <SlidingPanels activeIndex={tab === "trips" ? 0 : 1}>
        {/* TRIPS */}
        {savedTrips.length === 0 ? (
          <ScrollView
            className="flex-1"
            contentContainerStyle={padBottom}
            showsVerticalScrollIndicator={false}
          >

              <EmptyState tab="trips" active={tab === "trips"} />

          </ScrollView>
        ) : (
          <SectionList
            // Wer scrollt, bekommt keine Textur — Begründung an der
            // Ticket-Liste weiter unten. Die Reise-Karten fordern sie beim
            // Aufsetzen genauso an.
            onScrollBeginDrag={releaseSavedLayer}
            /**
             * Ausdrücklicher Stil, KEIN `className`.
             *
             * NativeWind bildet `className` nur auf die Komponenten ab, die es
             * ausdrücklich anmeldet — `FlatList` steht in dieser Liste,
             * `SectionList` nicht. Die Angabe wäre hier also stillschweigend
             * ins Leere gelaufen, und ohne `flex: 1` füllt die Liste ihren
             * Bereich im Blätter-Container nicht aus.
             */
            style={FILL}
            sections={tripSections}
            keyExtractor={tripKey}
            renderItem={renderTrip}
            renderSectionHeader={renderTripSection}
            stickySectionHeadersEnabled={false}
            contentContainerStyle={padBottomGutter}
            showsVerticalScrollIndicator={false}
            // Nur das Sichtbare aufbauen. Eine gespeicherte Reise ist eine große
            // Karte — mehr als sechs passen ohnehin nicht auf den Bildschirm.
            windowSize={5}
            initialNumToRender={6}
            maxToRenderPerBatch={4}
            removeClippedSubviews
          />
        )}

        {/* TICKETS */}
        <FlatList
      /**
           * Wer scrollt, bekommt keine Textur — sie sofort wieder abgeben.
           *
           * Die Karten dieser Liste fordern die bildschirmfüllende Ebene beim
           * AUFSETZEN des Fingers an, weil ihr Aufbau 66ms dauert und deshalb nicht
           * in den Start einer Bewegung fallen darf. Wird aus dem Aufsetzen aber ein
           * SCROLLEN, lag sie bis zu 1,4 Sekunden über einer bewegten Fläche — und
           * dort ist eine Ebene teurer als gar keine: Sie wird in jedem Bild
           * ungültig und muss neu hochgeladen werden. Ein Tipp erreicht diese Zeile
           * nie. Dieselbe Behandlung wie im Landingscreen.
           */
          onScrollBeginDrag={releaseSavedLayer}
          // Ausdrücklich, aus demselben Grund wie bei der Liste darüber —
          // hier würde `className` zwar greifen, aber zwei Schreibweisen für
          // dasselbe nebeneinander laden nur zum nächsten Irrtum ein.
          style={FILL}
          data={tickets}
          keyExtractor={ticketKey}
          renderItem={renderTicket}
          ListHeaderComponent={
            <>
              <AddTicketButton onPress={openAddTicket} bgColor={appBg} />
              {tickets.length > 0 && (
                <Text className="text-[13px] text-[#56565C] font-medium mx-5 mb-2.5">
                  {ticketCountLine}
                </Text>
              )}
            </>
          }
          // `active` MUSS mit: Beide Panels bleiben gleichzeitig gemountet, und ohne
          // die Angabe steht der Vorgabewert `true` — die drei Endlos-Schleifen der
          // Herzen liefen dann im verdeckten Panel weiter, während man nebenan
          // arbeitet. Die Doku der Eigenschaft beschreibt genau diesen Fall.
          ListEmptyComponent={<EmptyState tab="tickets" active={tab === "tickets"} />}
          contentContainerStyle={padBottom}
          showsVerticalScrollIndicator={false}
          windowSize={5}
          initialNumToRender={5}
          maxToRenderPerBatch={4}
          removeClippedSubviews
        />
      </SlidingPanels>
      </ParallaxLayer>

      <AddTicketModal
        visible={showModal}
        onClose={() => setShowModal(false)}
        onAdd={addTicket}
      />
    </SafeAreaView>
  );
}

/** Zeilenabstand der Reise-Liste — als Konstante, nicht als Literal im JSX.
 *  Ein Objektliteral dort ist bei jedem Bild ein NEUES Objekt, also für jede
 *  Zeile ein Stil-Vergleich, der garantiert scheitert. */
const rowGap = { marginBottom: 12 } as const;

/** Füllt den Bereich im Blätter-Container. Siehe Begründung an der SectionList. */
const FILL = { flex: 1 } as const;

/** Ruhestellung — als Konstante, damit das Worklet kein neues Objekt pro Bild baut. */
const NO_PARALLAX = { transform: [{ translateX: 0 }] } as const;
