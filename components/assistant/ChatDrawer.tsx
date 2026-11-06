import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Clock,
  Gift,
  MoreHorizontal,
  Pencil,
  Pin,
  SquarePen,
  Trash2,
  User,
  X,
} from "lucide-react-native";
import { useBoView } from "@/lib/assistant/boView";
import { ClearSearchHistoryAlert } from "@/components/ui/ClearSearchHistoryAlert";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { RenameThreadDialog } from "@/components/assistant/RenameThreadDialog";
import { ScreenHeading } from "@/components/ui/ScreenHeading";
import { ASSISTANT_DRAWER_SCALE } from "@/lib/nav/overlayCover";
import {
  ChatAuthError,
  chatThreadKey,
  chatThreadsKey,
  chatThreadsKeyFor,
  deleteChatThread,
  fetchChatThreads,
  renameChatThread,
  setChatThreadArchived,
  setChatThreadPinned,
  type ChatThreadSummary,
  CHAT_THREADS_PAGE_SIZE,
} from "@/lib/api/chats";
import { haptic } from "@/lib/haptics";
import { useT } from "@/lib/i18n/useT";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { CLOSE_ICON_SIZE, GUTTER, SPACE, TOPBAR_TOP, TITLE_GAP } from "@/lib/theme/spacing";
import { ms, scaledStyles } from "@/lib/ui/compact";
import { useSearchStore } from "@/stores/searchStore";
import { StatePanel } from "@/components/ui/StatePanel";
import { GridLoader } from "@/components/ui/GridLoader";
import { GateLoader, useLoadGate } from "@/components/ui/LoadGate";

/**
 * Die Schublade hinter dem Bo-Screen: „Neuer Chat" und die früheren
 * Unterhaltungen.
 *
 * Sie ist eine RUHENDE Fläche — keine Ein-/Ausfahrt, kein Auf- und Zuklappen,
 * kein `zIndex` und keine `elevation`. Bewegt wird der Bo-Screen DAVOR
 * (schrumpfen und nach rechts schieben), und die Schichtung entsteht außen. Das
 * ist keine Bequemlichkeit, sondern die Bedingung dafür, dass die Bewegung
 * ruhig bleibt: Läge hier eine zweite Animation, liefen zwei Kurven gegen
 * dieselben Bilder, und eine eigene `elevation` würde die Schublade auf Android
 * über fremde Blätter heben — dieselbe Falle, die im Benachrichtigungs-Blatt
 * ausführlich steht.
 */

/**
 * Auf so viel schrumpft der Bo-Screen davor.
 *
 * Aus der Bewegung IMPORTIERT und nicht hier nachgetragen: Die Inhalts-Spalte
 * rechnet mit demselben Wert, mit dem der Bildschirm verkleinert wird. Zwei
 * Kopien laufen irgendwann auseinander, und das Ergebnis wäre kein Fehler,
 * sondern ein Detail, das niemand sofort benennen kann — Text, der unter dem
 * stehengebliebenen Rest verschwindet.
 */
const SCALE = ASSISTANT_DRAWER_SCALE;

/**
 * Welcher Anteil des Bildschirms rechts verdeckt bleibt.
 *
 * Der geschrumpfte Screen ist `SCALE` breit und steht zur HÄLFTE über dem
 * rechten Rand — sichtbar bleibt also `SCALE / 2`, bei 0,72 gerundet 36%. Der
 * Inhalt hat damit die linken 64%. Ausgerechnet statt geraten: Eine feste Zahl
 * stimmt auf genau einer Bildschirmbreite.
 */
const COVERED = SCALE / 2;



const C = {
  white: "#F4F4F5",
  /** Zweite Textebene — derselbe Ton wie in allen Leerzuständen der App. */
  gray: "#8E8E93",
  /** Der X-Knopf trägt in Ortswähler, Bo und Spracheingabe denselben Ton. */
  closeIcon: "#E5E7EB",
  /** Papierkorb-Rot — derselbe Wert wie im Benachrichtigungs-Blatt. */
  danger: "#FF3B5C",
};

/** So viele Chats passen beim Öffnen sichtbar in die Schublade. */
const DRAWER_FIRST_ROWS = 9;

/** Was `fetchChatThreads` in den Zwischenspeicher legt. */
type ThreadPage = { items: ChatThreadSummary[]; nextCursor: string | null };

/**
 * Innenabstand, der aus dem 26er-Zeichen eine 44er-Trefferfläche macht.
 *
 * Er wird von einem gleich großen negativen Außenabstand wieder aufgehoben —
 * die Fläche ist damit groß genug für den Finger, ohne dass sie im Layout
 * Platz beansprucht oder das Zeichen verschiebt. Dieselbe Rechnung steht in
 * Bos Kopfzeile.
 */
const CLOSE_PAD = (44 - CLOSE_ICON_SIZE) / 2;

/** Abstand zwischen zwei Karten — wie im Landingscreen. */
const CARD_GAP = 8;
/** Breite und geschätzte Höhe der Menü-Karte — beides wird zum Klemmen
 *  gebraucht, bevor die Karte je gemessen werden kann. */
const MENU_W = 200;
const MENU_H = 208;

/**
 * Wohin die Menü-Karte gehört.
 *
 * Sie hängt am Berührungspunkt, darf aber weder aus der Spalte noch unten aus
 * dem Bild laufen. Beides sind Klemmungen, keine Bedingungen: Eine feste Lage
 * stimmte auf genau einem Gerät, und ein „wenn es nicht passt, dann oben"
 * ohne Klemmung springt bei jeder zweiten Zeile.
 */
function menuPosition(
  at: { x: number; y: number },
  columnWidth: number,
  screenH: number,
  insetBottom: number,
): { left: number; top: number } {
  const w = ms(MENU_W);
  const h = ms(MENU_H);
  // Rechte Kante an den Finger, dann in die Spalte zwingen.
  const left = Math.min(Math.max(ms(SPACE.md), at.x - w), Math.max(ms(SPACE.md), columnWidth - w));
  const below = at.y + ms(SPACE.sm);
  // Passt es unten nicht mehr, klappt die Karte über den Finger.
  const top = below + h > screenH - insetBottom ? Math.max(ms(SPACE.md), at.y - h) : below;
  return { left, top };
}

/**
 * Eine Zeile im oberen Block der Schublade („Neuer Chat", „Geplant").
 *
 * Sie sieht bewusst aus wie eine Chat-Zeile und nicht wie ein Knopf: In der
 * Vorlage ist die Seitenleiste EINE Liste, in der oben die Aktionen und unten
 * die Unterhaltungen stehen. Eine hervorgehobene Pille oben bräche diese
 * Lesart und wäre außerdem das einzige Element der Schublade mit eigener
 * Fläche.
 */
function NavRow({
  icon,
  label,
  onPress,
  bg,
  activeBg,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  /** Fläche der Karte — eine Stufe dunkler als die Schublade. */
  bg: string;
  /** Gesetzt = die Zeile ist gerade die gewählte. */
  activeBg?: string;
}) {
  return (
    /**
     * `RippleTouch` und nicht `Pressable` — beides aus DEMSELBEN Grund.
     *
     * Die Hauskomponente sagt ihn selbst: NativeWind v4 schluckt in seiner
     * JSX-Zwischenschicht Eigenschaften an `Pressable`, deshalb bleibt dort
     * `android_ripple` unsichtbar. Genau das hat hier auch die STIL-FUNKTION
     * getroffen — Zeilen, deren Stil als Funktion überreicht wurde, kamen ohne
     * Layout an: Zeichen über der Beschriftung, kein Innenabstand, keine
     * Rundung. Zwei Symptome, eine Ursache.
     *
     * `RippleTouch` löst beides: Es rendert auf Android `TouchableNativeFeedback`
     * mit echtem Material-Ripple und flacht den Stil selbst ab.
     */
    <RippleTouch
      onPress={onPress}
      accessibilityLabel={label}
      style={[
        styles.navRow,
        { backgroundColor: bg },
        activeBg ? { backgroundColor: activeBg } : null,
      ]}
    >
      {icon}
      <Text style={styles.navLabel} numberOfLines={1}>
        {label}
      </Text>
    </RippleTouch>
  );
}

/**
 * Eine Chat-Zeile mit Wisch-Löschen — dieselbe Mechanik wie die Verlaufs-Karten
 * im Landingscreen (`components/home/RecentCard.tsx`), inklusive der beiden
 * Fallen, die dort schon teuer bezahlt wurden:
 *
 *  1. Löschen läuft in ZWEI Schritten. Erst trägt sich die Karte nach links
 *     aus, danach schließt sich die Lücke. Wer den Eintrag mitten in der
 *     Bewegung aus der Liste nimmt, sieht sie nie zu Ende — alles darunter
 *     springt schlagartig hoch.
 *  2. Die Lösch-Zone hängt nur im Lösch-Zustand im Baum und beginnt erst 24
 *     Punkte vom linken Rand. Zwei gerundete Rechtecke mit demselben Radius
 *     übereinander lassen an den Ecken Rot durch die Kantenglättung
 *     schimmern; weiter links als die Wischstrecke wird ohnehin nichts
 *     aufgedeckt.
 */
const DELETE_WIDTH = 80;
const CANCEL_THRESHOLD = 30;
const SWIPE_MS = 220;
const SWIPE_EASE = Easing.out(Easing.quad);
/** Leere Liste, solange das Tor lädt — fest, damit die Liste nicht bei jedem Durchgang neue Daten sieht. */
const NO_THREADS: readonly never[] = [];

const ChatRow = memo(function ChatRow({
  item,
  active,
  swiped,
  bg,
  titleColor,
  label,
  moreLabel,
  deleteLabel,
  onPress,
  onLongPress,
  onCancelSwipe,
  onMenu,
  onDelete,
}: {
  item: ChatThreadSummary;
  active: boolean;
  swiped: boolean;
  bg: string;
  titleColor: string;
  label: string;
  moreLabel: string;
  deleteLabel: string;
  onPress: () => void;
  onLongPress: () => void;
  onCancelSwipe: () => void;
  onMenu: (x: number, y: number) => void;
  onDelete: () => void;
}) {
  const rowH = useSharedValue(0);
  const collapse = useSharedValue(1);
  const [collapsing, setCollapsing] = useState(false);
  const translateX = useSharedValue(0);
  const startX = useSharedValue(0);

  const collapseStyle = useAnimatedStyle(() => ({
    height: rowH.value * collapse.value,
    marginBottom: CARD_GAP * collapse.value,
    opacity: collapse.value,
  }));
  const cardAnim = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));

  /**
   * Die Lage folgt der Ansage von außen.
   *
   * Sie hier nicht selbst zu verwalten ist der Grund, warum nie zwei Zeilen
   * gleichzeitig offen stehen können: Es gibt nur einen Merker, und der liegt
   * in der Liste.
   */
  useEffect(() => {
    if (collapsing) return;
    translateX.value = withTiming(swiped ? -DELETE_WIDTH : 0, {
      duration: SWIPE_MS,
      easing: SWIPE_EASE,
    });
  }, [swiped, collapsing, translateX]);

  // Schritt 2 des Löschens: Höhe und Abstand auf null. Weil das echte
  // Layout-Werte sind, rücken die Zeilen darunter stetig nach.
  useEffect(() => {
    if (!collapsing) return;
    collapse.value = withTiming(0, { duration: SWIPE_MS, easing: SWIPE_EASE }, (finished) => {
      "worklet";
      if (finished) runOnJS(onDelete)();
    });
  }, [collapsing, collapse, onDelete]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(swiped)
        .activeOffsetX([-10, 10])
        // Senkrechte Bewegungen gehören der Liste — sonst kann man über einer
        // offenen Zeile nicht mehr scrollen.
        .failOffsetY([-10, 10])
        .onStart(() => {
          startX.value = translateX.value;
        })
        .onUpdate((e) => {
          translateX.value = Math.max(-DELETE_WIDTH, Math.min(0, startX.value + e.translationX));
        })
        .onEnd((e) => {
          if (e.translationX > CANCEL_THRESHOLD) {
            runOnJS(onCancelSwipe)();
            return;
          }
          translateX.value = withTiming(-DELETE_WIDTH, {
            duration: SWIPE_MS,
            easing: SWIPE_EASE,
          });
        }),
    [swiped, onCancelSwipe, startX, translateX],
  );

  return (
    <Animated.View
      style={[styles.rowWrap, collapsing && collapseStyle]}
      onLayout={(e) => {
        if (!collapsing) rowH.value = e.nativeEvent.layout.height;
      }}
    >
      {swiped ? (
        <View style={styles.deleteZone}>
          <Pressable
            onPress={() => {
              // Erst austragen, dann zusammenfahren — siehe oben.
              translateX.value = withTiming(
                -400,
                { duration: SWIPE_MS, easing: SWIPE_EASE },
                (finished) => {
                  "worklet";
                  if (finished) runOnJS(setCollapsing)(true);
                },
              );
            }}
            accessibilityRole="button"
            accessibilityLabel={deleteLabel}
            style={styles.deleteBtn}
          >
            <Trash2 size={20} color="#F4F4F5" strokeWidth={2.2} />
          </Pressable>
        </View>
      ) : null}

      <GestureDetector gesture={pan}>
        <Animated.View style={cardAnim}>
          <RippleTouch
            onPress={onPress}
            onLongPress={onLongPress}
            accessibilityLabel={label}
            style={[styles.row, { backgroundColor: bg }]}
          >
            <View style={styles.rowText}>
              <View style={styles.rowTitleLine}>
                {/* Warum diese Zeile oben steht, muss man sehen können — sonst
                    wirkt die Sortierung willkürlich. */}
                {item.pinnedAt ? <Pin size={12} color={C.gray} strokeWidth={2.5} /> : null}
                <Text style={[styles.rowTitle, { color: titleColor }]} numberOfLines={1}>
                  {label}
                </Text>
              </View>
            </View>

            <Pressable
              onPress={(e) => onMenu(e.nativeEvent.pageX, e.nativeEvent.pageY)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={moreLabel}
            >
              <MoreHorizontal size={20} color={active ? C.white : C.gray} strokeWidth={2} />
            </Pressable>
          </RippleTouch>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
});

function MenuItem({
  icon,
  label,
  onPress,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <RippleTouch onPress={onPress} accessibilityLabel={label} style={styles.menuItem}>
      {icon}
      <Text style={[styles.menuLabel, danger && { color: C.danger }]} numberOfLines={1}>
        {label}
      </Text>
    </RippleTouch>
  );
}

/** Initialen für den Fall ohne Bild — Vorname/Nachname, sonst die E-Mail. */
function initials(first: string, last: string, email: string): string {
  const a = first.trim()[0] ?? "";
  const b = last.trim()[0] ?? "";
  const both = `${a}${b}`.toUpperCase();
  return both || (email.trim()[0] ?? "?").toUpperCase();
}

interface Props {
  /**
   * Nur zum Sperren von Berührungen und als Schalter fürs Laden — an DIESEM
   * Wert hängt bewusst keine Animation.
   */
  open: boolean;
  /** Gerade geöffnete Unterhaltung; wird hervorgehoben. */
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onClose: () => void;
  /** Tipp auf die Profil-Karte: Bo schließen und in den Profil-Tab wechseln. */
  onOpenProfile: () => void;
  /** Bereich „Geplant" im Fenster zeigen. */
  onOpenScheduled: () => void;
}

export function ChatDrawer({
  open,
  activeId,
  onSelect,
  onNewChat,
  onClose,
  onOpenProfile,
  onOpenScheduled,
}: Props) {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const queryClient = useQueryClient();
  const authUser = useSearchStore((s) => s.authUser);
  const userId = authUser?.id ?? null;

  /**
   * Die Breite der Inhalts-Spalte — zur Laufzeit, nicht im Stilblatt.
   *
   * Sie hängt an der Bildschirmbreite, kann also gar nicht als feste Zahl
   * dastehen. Die Luft zum geschrumpften Screen geht durch `ms()`, weil dieser
   * Wert am Element landet und NICHT durch `scaledStyles` läuft — dort bekäme
   * er den Faktor ein zweites Mal.
   */
  /**
   * Die Spalte endet GENAU dort, wo der geschrumpfte Bo-Screen beginnt.
   *
   * Hier ging vorher noch ein Abstand ab. Das kostete das X oben zwölf Punkte
   * nach links, und genau das fiel auf: In Bo sitzt es einen Rand vom
   * Bildschirmrand entfernt, hier saß es einen Rand PLUS diesen Abstand von der
   * Kante der Schublade. Den Abstand zum Screen macht jetzt der Rand der
   * Kopfzeile selbst — ein Maß statt zweier.
   */
  const columnWidth = Math.max(0, Math.round(width * (1 - COVERED)));

  /**
   * Wie weit die untere Kante des Bo-Screens über dem Bildschirmrand liegt.
   *
   * Die Verkleinerung auf `SCALE` geschieht um die MITTE — oben und unten
   * bleibt deshalb je die Hälfte des Fehlbetrags frei. Genau auf dieser Höhe
   * endet die Angebots-Karte, damit beide Unterkanten auf einer Linie liegen.
   *
   * Gerechnet und nicht gemessen: Der Wert hängt allein an Fensterhöhe und
   * Schrumpf-Faktor, beides steht hier zur Verfügung. Eine Messung am
   * Bo-Screen wäre eine zweite Wahrheit, die auseinanderlaufen kann.
   */
  const bottomGap = Math.round((height * (1 - SCALE)) / 2);

  const { data, isLoading, isError, isFetching, error, refetch } = useQuery({
    /**
     * Der Schlüssel trägt das KONTO.
     *
     * Ohne es lag die Liste unter einem gemeinsamen Schlüssel: Nach einem
     * Kontowechsel zeigte der Zwischenspeicher weiter die Unterhaltungen des
     * vorigen Kontos, bis die App neu startete. Mit dem Konto im Schlüssel ist
     * es ein anderer Eintrag — es gibt nichts zu leeren, es wird schlicht
     * nichts Falsches gefunden.
     *
     * `chatThreadsKey` bleibt als PRÄFIX für das Ungültigmachen: Ein Aufruf
     * darauf trifft weiterhin jeden Konto-Eintrag.
     */
    queryKey: chatThreadsKeyFor(userId),
    queryFn: () => fetchChatThreads({ limit: CHAT_THREADS_PAGE_SIZE }),
    /**
     * Läuft ab dem MOUNT, nicht erst ab dem Öffnen.
     *
     * Hier stand `enabled: open` — unter der Annahme, die Schublade hänge
     * dauerhaft im Baum. Sie tut es nicht: Der Bildschirm baut sie erst auf,
     * wenn der Finger auf dem Zeichen liegt, und setzt `open` erst, wenn die
     * Fahrt DURCH ist. Mit dem Schalter begann die Abfrage also nach der
     * Bewegung, und die Liste erschien sichtbar verspätet.
     *
     * Das Mounten ist damit selbst der Schalter — und es fällt in die 80 bis
     * 150ms des Fingers, in denen ohnehin gewartet wird. Zusammen mit dem
     * Vorabruf beim Betreten des Bo-Tabs steht die Liste, bevor sie zu sehen
     * ist.
     */
    staleTime: 60_000,
    /**
     * Ein 401 wird NICHT wiederholt.
     *
     * Der Standard der App ist ein Wiederholungsversuch, und der ist hier
     * schädlich: Wer nicht angemeldet ist, bleibt es auch beim zweiten Versuch —
     * der Nutzer sähe nur doppelt so lange den Ladezustand, bevor endlich
     * „Melde dich an" erscheint.
     */
    retry: (count, err) => !(err instanceof ChatAuthError) && count < 1,
  });

  /**
   * Erstes Laden nach der einen Regel (`LoadGate`): Lader erst nach 2 s, dann
   * mindestens zwei volle Durchläufe; die Chats erscheinen erst danach und
   * blenden ein. Bis dahin hält die Liste ihre Zeilen zurück.
   */
  const gate = useLoadGate(isLoading);
  const listFade = useSharedValue(1);
  useEffect(() => {
    if (gate.phase !== "content" || !gate.fresh) return;
    listFade.value = 0;
    listFade.value = withTiming(1, { duration: 280, easing: Easing.out(Easing.quad) });
  }, [gate.phase, gate.fresh, listFade]);
  const listFadeStyle = useAnimatedStyle(() => ({ opacity: listFade.value }));
  const threads = gate.phase === "content" ? (data?.items ?? []) : NO_THREADS;
  const signedOut = error instanceof ChatAuthError;

  /* ------------------------------------------------------------ Nachladen */

  const [loadingMore, setLoadingMore] = useState(false);

  /**
   * Der Zeiger kommt aus dem Zwischenspeicher, nicht aus `data`.
   *
   * `data` ist der Stand DIESES Durchgangs. Zwei Auslöser von `onEndReached`
   * kurz hintereinander — und die FlatList feuert gern doppelt — läsen damit
   * beide denselben Zeiger und hängten dieselbe Seite zweimal an. Aus dem
   * Zwischenspeicher gelesen ist der Zeiger nach dem ersten Schreiben bereits
   * fortgeschrieben.
   */
  const loadMore = useCallback(() => {
    if (!open || loadingMore) return;
    const cursor = queryClient.getQueryData<ThreadPage>(chatThreadsKeyFor(userId))?.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    fetchChatThreads({ limit: CHAT_THREADS_PAGE_SIZE, cursor })
      .then((page) => {
        queryClient.setQueryData<ThreadPage>(chatThreadsKeyFor(userId), (prev) => {
          if (!prev) return page;
          // Nach Kennung entdoppeln: Kommt zwischen zwei Seiten eine neue
          // Unterhaltung dazu, verschiebt sich das Fenster und der Server
          // liefert einen Eintrag ein zweites Mal. Die FlatList quittiert
          // doppelte Schlüssel mit einer Warnung und einer kaputten Auswahl.
          const seen = new Set(prev.items.map((i) => i.id));
          return {
            items: [...prev.items, ...page.items.filter((i) => !seen.has(i.id))],
            nextCursor: page.nextCursor,
          };
        });
      })
      .catch(() => {
        // Stumm: Die erste Seite steht schon da. Eine Fehlermeldung für eine
        // gescheiterte ZWEITE Seite verdeckte eine funktionierende Liste.
      })
      .finally(() => setLoadingMore(false));
    // `userId` mit: Nach einem Kontowechsel liefe das Nachladen sonst gegen den
    // Zwischenspeicher des vorigen Kontos.
  }, [open, loadingMore, queryClient, userId]);

  /* -------------------------------------------------------------- Löschen */

  const [pendingDelete, setPendingDelete] = useState<ChatThreadSummary | null>(null);

  /**
   * Die aktive Kennung über eine Ref, nicht über die Closure.
   *
   * Verglichen wird NACH dem `await` des Löschens, und in dieser Zeit kann der
   * Nutzer längst eine andere Unterhaltung geöffnet haben. Der Wert aus dem
   * Durchgang, in dem der Dialog gebaut wurde, wäre dann veraltet — und
   * `onNewChat()` liefe entweder zu Unrecht oder gar nicht.
   */
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const confirmDelete = useCallback(() => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    deleteChatThread(target.id)
      .then(() => {
        // Ohne Nachladen: Was weg ist, weiß der Aufrufer selbst. Ein
        // `invalidateQueries` würde die Liste sichtbar neu aufbauen, obwohl sich
        // genau eine Zeile geändert hat.
        queryClient.setQueryData<ThreadPage>(chatThreadsKeyFor(userId), (prev) =>
          prev ? { ...prev, items: prev.items.filter((i) => i.id !== target.id) } : prev,
        );
        queryClient.removeQueries({ queryKey: chatThreadKey(target.id) });
        // Der offene Verlauf zeigt jetzt auf nichts mehr — der Screen davor
        // muss auf einen leeren Chat wechseln, sonst steht dort eine
        // Unterhaltung, die es nicht mehr gibt.
        if (target.id === activeIdRef.current) onNewChat();
      })
      .catch(() => {
        // Fehlgeschlagen — die Wahrheit kommt vom Server. Hier NICHT optimistisch
        // entfernen und wieder einsetzen: Eine Zeile, die verschwindet und
        // zurückspringt, liest sich als Fehler der App.
        void queryClient.invalidateQueries({ queryKey: chatThreadsKey });
      });
  }, [pendingDelete, queryClient, onNewChat, userId]);

  /* ----------------------------------------------------------------- Menü */

  /**
   * Das Zeilen-Menü — Lage aus dem BERÜHRUNGSPUNKT, nicht aus einer Messung.
   *
   * Naheliegend wäre ein Ref je Zeile und `measureInWindow`. In einer Liste ist
   * das zusätzliche Buchhaltung für jede gemountete Zeile, und gebraucht wird
   * am Ende nur ein Punkt. Den liefert das Ereignis selbst mit — und zwar
   * genau dort, wo der Finger war.
   */
  /** Steht „Geplant" im Fenster, ist das die aktuelle Zeile und keine Unterhaltung. */
  const scheduledShown = useBoView() === "scheduled";
  const highlightId = scheduledShown ? null : activeId;
  /**
   * Die Höhe der unteren Leiste — GEMESSEN, nicht gerechnet.
   *
   * Sie liegt absolut über der Spalte, damit sie die volle Bildschirmbreite
   * bekommt (unterhalb des geschrumpften Bo-Screens ist sie frei). Damit die
   * Liste nicht darunter läuft, braucht die Spalte genau diese Höhe als
   * Abstand — und die hängt an Schriftgröße und Skalierung, ist also keine
   * Zahl, die man hinschreiben kann.
   */
  const [barH, setBarH] = useState(0);
  const [menu, setMenu] = useState<{ item: ChatThreadSummary; x: number; y: number } | null>(null);
  const [pendingRename, setPendingRename] = useState<ChatThreadSummary | null>(null);

  const patchList = useCallback(
    (fn: (items: ChatThreadSummary[]) => ChatThreadSummary[]) => {
      queryClient.setQueryData<ThreadPage>(chatThreadsKeyFor(userId), (prev) =>
        prev ? { ...prev, items: fn(prev.items) } : prev,
      );
    },
    [queryClient, userId],
  );

  const confirmRename = useCallback(
    (title: string) => {
      const target = pendingRename;
      setPendingRename(null);
      if (!target) return;
      // Sofort anzeigen: Der Titel ist das, was der Nutzer gerade selbst
      // getippt hat — hier auf die Antwort zu warten wäre eine Verzögerung
      // ohne Erkenntnisgewinn.
      patchList((items) => items.map((i) => (i.id === target.id ? { ...i, title } : i)));
      renameChatThread(target.id, title).catch(() => {
        // Fehlgeschlagen — die Wahrheit kommt vom Server.
        void queryClient.invalidateQueries({ queryKey: chatThreadsKey });
      });
    },
    [pendingRename, patchList, queryClient],
  );

  const togglePin = useCallback(
    (item: ChatThreadSummary) => {
      const next = item.pinnedAt === null;
      /**
       * Hier wird NICHT lokal umsortiert.
       *
       * Die Reihenfolge gehört dem Server (angeheftete zuerst, danach nach
       * Aktualität) und sie hängt am Cursor der nächsten Seite. Sie hier
       * nachzubauen hieße, dieselbe Regel ein zweites Mal zu schreiben — und
       * die zweite Fassung ist die, die irgendwann abweicht.
       */
      setChatThreadPinned(item.id, next)
        .catch(() => undefined)
        .finally(() => void queryClient.invalidateQueries({ queryKey: chatThreadsKey }));
    },
    [queryClient],
  );

  const archiveThread = useCallback(
    (item: ChatThreadSummary) => {
      // Archivieren heißt „aus der Liste nehmen" — die Zeile verschwindet
      // sofort, ein Nachladen würde nur dasselbe Ergebnis bestätigen.
      patchList((items) => items.filter((i) => i.id !== item.id));
      if (item.id === activeIdRef.current) onNewChat();
      setChatThreadArchived(item.id, true).catch(() => {
        void queryClient.invalidateQueries({ queryKey: chatThreadsKey });
      });
    },
    [patchList, queryClient, onNewChat],
  );

  /* --------------------------------------------------------------- Zeilen */

  /**
   * Welche Zeile gerade ihre Lösch-Zone zeigt — GENAU EINE.
   *
   * Der Zustand liegt hier und nicht in der Zeile: Sonst könnten mehrere
   * gleichzeitig offen stehen, und man müsste jede einzeln wieder schließen.
   */
  const [swipeId, setSwipeId] = useState<string | null>(null);

  const removeThread = useCallback(
    (id: string) => {
      patchList((items) => items.filter((i) => i.id !== id));
      queryClient.removeQueries({ queryKey: chatThreadKey(id) });
      if (id === activeIdRef.current) onNewChat();
      deleteChatThread(id).catch(() => {
        // Fehlgeschlagen — die Wahrheit kommt vom Server.
        void queryClient.invalidateQueries({ queryKey: chatThreadsKey });
      });
    },
    [patchList, queryClient, onNewChat],
  );

  const renderItem = useCallback(
    ({ item }: { item: ChatThreadSummary }) => (
      <ChatRow
        item={item}
        active={item.id === highlightId}
        swiped={item.id === swipeId}
        bg={item.id === highlightId ? accent.subtle : palette.s2}
        titleColor={item.id === highlightId ? accent.solid : C.white}
        label={item.title ?? t("assistant.threads.untitled")}
        moreLabel={t("assistant.threads.more")}
        deleteLabel={t("assistant.threads.delete.confirm")}
        onPress={() => {
          if (swipeId) {
            // Ein Tipp auf eine Karte im Lösch-Zustand nimmt ihn zurück,
            // statt die Unterhaltung zu öffnen — sonst öffnet man beim
            // Aufräumen versehentlich einen Chat.
            setSwipeId(null);
            return;
          }
          haptic("button");
          onSelect(item.id);
        }}
        onLongPress={() => {
          haptic("important");
          setSwipeId(item.id);
        }}
        onCancelSwipe={() => setSwipeId(null)}
        onMenu={(x, y) => {
          haptic("button");
          setSwipeId(null);
          setMenu({ item, x, y });
        }}
        onDelete={() => {
          haptic("important");
          setSwipeId(null);
          removeThread(item.id);
        }}
      />
    ),
    [accent.solid, accent.subtle, highlightId, onSelect, palette.s2, removeThread, swipeId, t],
  );

  /**
   * Die vier Zustände unter „Neuer Chat".
   *
   * Reihenfolge ist Absicht: Fehlende Anmeldung schlägt jeden anderen Zustand,
   * denn dahinter kann nichts geladen worden sein. Erst danach ein echter
   * Fehler, dann das Laden — und nur wenn nichts davon zutrifft, ist die Liste
   * wirklich leer.
   */
  const renderEmpty = () => {
    /**
     * Alle Zustände der Liste wie überall in der App: Zeichnung, Titel, Satz und
     * EIN Pillen-Knopf (`StatePanel`), mittig im freien Teil der Schublade.
     * Vorher standen hier nackte Zeilen mit einem Text-Link („einfach dahin
     * geklatscht", 04.11.2026). Gezeichnet wird erst, wenn die Schublade aufgeht.
     */
    if (signedOut) {
      return (
        <StatePanel
          compact
          art="chat"
          active={open}
          surface={palette.s3}
          title={t("assistant.threads.signedOutTitle")}
          body={t("assistant.threads.signedOut")}
          action={t("state.signIn")}
          onAction={() => {
            haptic("button");
            useSearchStore.getState().openAuthOverlay();
          }}
          style={styles.emptyCenter}
        />
      );
    }
    if (isError) {
      return (
        <StatePanel
          compact
          art="offline"
          active={open}
          surface={palette.s3}
          title={t("state.error.title")}
          body={t("assistant.threads.error")}
          action={t("state.retry")}
          busy={isFetching}
          onAction={() => {
            haptic("button");
            void refetch();
          }}
          style={styles.emptyCenter}
        />
      );
    }
    /**
     * Ein kleiner Kreis, kein bildschirmfüllender Ladezustand.
     *
     * Die Liste steht ab dem zweiten Öffnen aus dem Zwischenspeicher sofort da;
     * ein großes Skelett wäre dann ein Aufblitzen für nichts. Sichtbar wird das
     * hier nur beim allerersten Mal.
     */
    if (gate.phase !== "content") {
      return (
        <View style={styles.loaderArea}>
          <GateLoader phase={gate.phase} onLeft={gate.onLeft}>
            <GridLoader size={44} active={open} />
          </GateLoader>
        </View>
      );
    }
    // Die Schublade hängt im vorgebauten Bo-Fenster dauerhaft — gezeichnet wird erst, wenn sie aufgeht.
    return (
      <StatePanel
        compact
        art="chat"
        active={open}
        surface={palette.s3}
        body={t("assistant.threads.empty")}
        style={styles.emptyCenter}
      />
    );
  };

  return (
    <View
      /**
       * `s3` und nicht `s2` — die Fläche muss sich vom Bo-Screen davor ABSETZEN.
       *
       * Sie lag auf `s2`, und genau das ist der Farbwert der Eingabeleiste in
       * Bo. Die beiden Flächen gingen ineinander über: Vom geschrumpften
       * Bildschirm war unten keine Kante mehr zu sehen. `bg`/`s1` scheiden aus
       * (das ist Bos eigener Grund), also bleibt `s3`.
       *
       * Folge, die man mitdenken muss: Alles, was AUF der Schublade liegt, ist
       * jetzt eine Stufe DUNKLER als sie (`s2`), nicht heller. Auf dunklem
       * Grund liest sich das als eingelassene Fläche und funktioniert — als
       * `s3` auf `s3` wäre es schlicht unsichtbar.
       */
      style={[StyleSheet.absoluteFill, { backgroundColor: palette.s3 }]}
      /**
       * Geschlossen nimmt sie KEINE Berührung an.
       *
       * Sie liegt hinter dem Bo-Screen und ist bildschirmfüllend — ohne diese
       * Sperre fingen ihre Zeilen Tipper ab, die dem Chat davor gelten, sobald
       * der dort nichts Berührbares hat.
       */
      pointerEvents={open ? "auto" : "none"}
    >
      <View style={[styles.column, { width: columnWidth, paddingBottom: barH + bottomGap }]}>
        {/*
          Die Kopfzeile ist DIESELBE wie in Bo, nicht eine ähnliche.

          `TOPBAR_TOP` und `CLOSE_BTN_SIZE` kommen aus dem gemeinsamen Raster
          (`lib/theme/spacing.ts`) — dort steht auch, warum der Wert kleiner ist
          als `HEADING_TOP`: Der runde Knopf ist höher als die Textzeile, und
          `alignItems: center` schöbe die Überschrift sonst um die halbe
          Differenz nach unten. Damit beginnt „Chats" auf exakt derselben Höhe
          wie Bos Schriftzug dahinter.

          `insets.top + TOPBAR_TOP` bleibt UNSKALIERT — genau wie in Bo. Beide
          Werte landen direkt am Element und laufen durch kein Stilblatt; durch
          `ms()` gedreht stünde die Zeile hier höher als dort.

          Waagerecht sitzt das X am Rand der SPALTE und nicht am Bildschirmrand:
          Dort steht der geschrumpfte Bo-Screen, der Knopf läge unter ihm.
        */}
        <View style={[styles.header, { paddingTop: insets.top + TOPBAR_TOP }]}>
          <View style={styles.headingWrap}>
            <ScreenHeading>{t("assistant.threads.title")}</ScreenHeading>
          </View>
          {/*
            Das X liegt IN der Zeile und wird von ihr senkrecht mittig gesetzt —
            genau wie in Bo.

            Vorher hing es absolut an derselben Oberkante wie die Überschrift.
            Das ist nicht dasselbe: Die Trefferfläche ist 44 hoch, die Textzeile
            32 — bei gleicher Oberkante sitzt das Zeichen also 6 Punkte tiefer
            als die Schrift. Genau das war zu sehen.

            Waagerecht ragt es über die Spalte hinaus bis an den Bildschirmrand:
            Der negative Rand ist exakt der Teil der Breite, den die Spalte NICHT
            hat. Damit steht es dort, wo Bos X steht, ohne dass die Zeile ihre
            Ausrichtung verliert.
          */}
          <Pressable
            onPress={() => {
              // Fehlte als einzige Stelle in diesem Blatt — jeder andere Knopf
              // hier meldet sich beim Drücken.
              haptic("button");
              onClose();
            }}
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            style={[
              styles.closeBtn,
              /**
               * Zwei Anteile, und der zweite ist der, den ich vergessen hatte.
               *
               * Der erste zieht die Spalte auf die volle Bildschirmbreite auf.
               * Der zweite hebt den INNENABSTAND der Trefferfläche auf: Sie ist
               * 44 breit, das Zeichen 26 — ohne ihn stünde das Zeichen 9 Punkte
               * weiter innen als in Bo, wo derselbe Innenabstand von einem
               * Außenabstand auf allen Seiten aufgehoben wird.
               *
               * `ms()`, weil der Wert aus dem Stilblatt kommt und dort skaliert
               * wird — hier landet er direkt am Element.
               */
              { marginRight: -(width - columnWidth) - ms(CLOSE_PAD) },
            ]}
          >
            <X color={C.closeIcon} size={CLOSE_ICON_SIZE} strokeWidth={2} />
          </Pressable>
        </View>

        <View style={styles.nav}>
          <NavRow
            icon={<SquarePen size={20} color={C.white} strokeWidth={2} />}
            label={t("assistant.threads.new")}
            bg={palette.s2}
            onPress={() => {
              haptic("button");
              onNewChat();
            }}
          />
          <NavRow
            icon={<Clock size={20} color={C.white} strokeWidth={2} />}
            label={t("assistant.threads.scheduled")}
            // `s2` auf `s3` — siehe die Begründung an der Wurzel-Fläche.
            bg={palette.s2}
            // Gewählt = die Fläche trägt den Akzent, dezent (16%). Über eine
            // Kante ginge es nicht mehr, seit die Karten keine tragen.
            activeBg={scheduledShown ? accent.subtle : undefined}
            onPress={() => {
              haptic("button");
              onOpenScheduled();
            }}
          />
        </View>

        {/*
          Die Überschrift steht ÜBER der Liste, nicht in ihr.

          Als `ListHeaderComponent` ist sie ein Listen-Eintrag und scrollt mit
          weg — bei vielen Chats war „Zuletzt" nach kurzem Scrollen nicht mehr
          zu sehen. Hier beschriftet sie den Abschnitt, und ein Abschnitt
          verschiebt sich nicht, weil man in ihm blättert.
        */}
        {threads.length > 0 ? (
          /**
           * Der Rand kommt von einer HÜLLE, nicht vom Text.
           *
           * In der Liste steckte die Überschrift im Inhalt und erbte dessen
           * Rand; außerhalb stand sie plötzlich am Spaltenrand. Die Hülle
           * setzt genau denselben Rand wie der Listeninhalt und wie der untere
           * Stapel — die Beschriftung selbst bringt nur ihren eigenen kleinen
           * Versatz mit und bleibt damit an allen drei Stellen identisch.
           */
          <View style={styles.sectionWrap}>
            <Text style={styles.sectionLabel}>{t("assistant.threads.recent")}</Text>
          </View>
        ) : null}
        <Animated.FlatList
          data={threads}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          /**
           * Das ERGEBNIS, nicht die Funktion: `ListEmptyComponent` nimmt beides,
           * behandelt eine Funktion aber als Komponenten-TYP — und der ist bei
           * jedem Durchgang ein neuer. Der Teilbaum würde damit jedes Mal ab-
           * und wieder aufgebaut, und der Ladekreis finge seine Drehung von
           * vorn an.
           */
          ListEmptyComponent={renderEmpty()}
          /** Nachgeladen wird nur bei offener Schublade — siehe `loadMore`. */
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          /**
           * Nur bauen, was man sieht — und während die Schublade fährt gar nichts
           * dazu. Mit den Vorgaben der Liste (21 Bildschirmhöhen Fenster, alle
           * 50 ms ein Schub) baute sie bei vielen geladenen Chats Zeile um Zeile
           * nach, jede mit eigener Wisch-Geste, mitten in der Fahrt. Das war das
           * Ruckeln. `open` kommt erst, wenn die Kurve steht; danach füllt sie in
           * Ruhe auf.
           */
          initialNumToRender={DRAWER_FIRST_ROWS}
          maxToRenderPerBatch={4}
          windowSize={5}
          updateCellsBatchingPeriod={open ? 50 : 10_000}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator size="small" color={C.gray} style={styles.spinner} />
            ) : null
          }
          /**
           * `flex: 1` ist Pflicht, seit die Konto-Zeile darunter steht.
           *
           * Ohne sie wächst die Liste in einer Flex-Spalte mit ihrem Inhalt und
           * schiebt alles Nachfolgende aus dem Bild — die Konto-Zeile wäre bei
           * langen Listen einfach weg.
           */
          style={[styles.list, listFadeStyle]}
          contentContainerStyle={threads.length > 0 ? styles.listContent : styles.listContentEmpty}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        />
      </View>

      {/*
        Die untere Leiste — Profil und Angebot NEBENEINANDER, über die volle
        Bildschirmbreite.

        Sie liegt aus demselben Grund außerhalb der Spalte wie das X oben: Der
        geschrumpfte Bo-Screen endet bei 86% der Höhe (Verkleinerung auf 72% um
        die Mitte), unten ist die Breite also wieder frei. In der Spalte
        eingesperrt bekäme die Leiste nur knapp zwei Drittel und die zweite
        Karte stünde gequetscht daneben.

        Die Höhe meldet sie selbst — die Spalte darüber hält genau so viel
        Abstand frei, damit die Liste nicht darunter läuft.
      */}
      <View
        style={[styles.bottomBar, { width: columnWidth, bottom: bottomGap }]}
        onLayout={(e) => setBarH(e.nativeEvent.layout.height)}
      >
        {/* Dieselbe Beschriftung wie „Zuletzt" darüber — gleicher Stil, damit
            beide als Abschnitts-Überschrift lesen. Der untere Innenabstand
            fällt hier weg: Den Abstand zur Karte macht schon der `gap` des
            Stapels, sonst stünde er doppelt. */}
        <Text style={[styles.sectionLabel, styles.bottomLabel]}>
          {t("assistant.threads.profile")}
        </Text>
        <RippleTouch
          onPress={() => {
            haptic("button");
            onOpenProfile();
          }}
          accessibilityLabel={
            authUser
              ? `${authUser.firstName} ${authUser.lastName}`.trim() || authUser.email
              : t("assistant.threads.signIn")
          }
          style={[styles.account, { backgroundColor: palette.s2 }]}
        >
          {authUser ? (
            <>
              {authUser.avatarDataUrl ? (
                <Image source={{ uri: authUser.avatarDataUrl }} style={styles.avatar} />
              ) : (
                <View
                  style={[styles.avatar, styles.avatarFallback, { backgroundColor: accent.subtle }]}
                >
                  <Text style={[styles.avatarInitials, { color: accent.solid }]}>
                    {initials(authUser.firstName, authUser.lastName, authUser.email)}
                  </Text>
                </View>
              )}
              <View style={styles.accountText}>
                <Text style={styles.accountName} numberOfLines={1}>
                  {`${authUser.firstName} ${authUser.lastName}`.trim() || authUser.email}
                </Text>
                <Text style={styles.accountMail} numberOfLines={1}>
                  {authUser.email}
                </Text>
              </View>
            </>
          ) : (
            <>
              {/* NICHT derselbe Satz wie im Leerzustand darüber — sonst stünde
                  „Melde dich an" zweimal untereinander im selben Bild. Hier
                  gehört hin, WER angemeldet ist; ist es niemand, steht genau
                  das da. */}
              <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: palette.s3 }]}>
                <User size={18} color={C.gray} strokeWidth={2} />
              </View>
              <View style={styles.accountText}>
                <Text style={styles.accountName} numberOfLines={1}>
                  {t("assistant.threads.signIn")}
                </Text>
              </View>
            </>
          )}
        </RippleTouch>

        {/* Dieselbe Karte wie die Zeilen oben — Zeichen links, Beschriftung
            daneben, gleiche Maße. Sie steht UNTER dem Profil, ihre Unterkante
            liegt auf der des Bo-Screens. */}
        <RippleTouch
          onPress={() => haptic("button")}
          accessibilityLabel={t("assistant.threads.claim")}
          style={[styles.claim, { backgroundColor: palette.s2 }]}
        >
          <Gift size={20} color={accent.solid} strokeWidth={2} />
          <Text style={styles.claimLabel} numberOfLines={1}>
            {t("assistant.threads.claim")}
          </Text>
        </RippleTouch>
      </View>

      {/*
        Das X sitzt am BILDSCHIRMRAND, nicht am Rand der Spalte.

        Das geht, obwohl rechts der geschrumpfte Bo-Screen steht: Der beginnt
        erst bei 14% der Höhe (die Verkleinerung auf 72% geschieht um die
        Mitte, oben und unten bleiben je 14% frei). Auf Höhe der Kopfzeile ist
        die volle Breite also noch Schublade — und damit steht das X exakt
        dort, wo es im Bo-Tab steht.

        Deshalb liegt es AUSSERHALB der Spalte: Die ist nur so breit wie der
        freie Teil und würde es nach links ziehen.
      */}
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
        style={[styles.closeBtn, { top: insets.top + TOPBAR_TOP }]}
      >
        <X color={C.closeIcon} size={CLOSE_ICON_SIZE} strokeWidth={2} />
      </Pressable>

      {/*
        Das Zeilen-Menü — außerhalb der Spalte, damit es nichts beschneidet.

        Zwei Schichten: eine bildschirmfüllende Fangfläche, die den Tipp daneben
        aufnimmt, und darüber die Karte. Beide gibt es nur, solange das Menü
        offen ist — eine dauerhaft liegende Fangfläche nähme der Liste darunter
        jede Berührung ab.
      */}
      {menu ? (
        <>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenu(null)} accessible={false} />
          <View
            style={[
              styles.menu,
              { backgroundColor: palette.s2 },
              menuPosition(menu, columnWidth, height, insets.bottom),
            ]}
          >
            <MenuItem
              icon={<Pencil size={17} color={C.white} strokeWidth={2} />}
              label={t("assistant.threads.rename")}
              onPress={() => {
                const item = menu.item;
                setMenu(null);
                setPendingRename(item);
              }}
            />
            <MenuItem
              icon={<Pin size={17} color={C.white} strokeWidth={2} />}
              label={
                menu.item.pinnedAt ? t("assistant.threads.unpin") : t("assistant.threads.pin")
              }
              onPress={() => {
                const item = menu.item;
                setMenu(null);
                togglePin(item);
              }}
            />
            <MenuItem
              icon={<Archive size={17} color={C.white} strokeWidth={2} />}
              label={t("assistant.threads.archive")}
              onPress={() => {
                const item = menu.item;
                setMenu(null);
                archiveThread(item);
              }}
            />
            <View style={[styles.menuRule, { backgroundColor: palette.s3 }]} />
            <MenuItem
              icon={<Trash2 size={17} color={C.danger} strokeWidth={2} />}
              label={t("assistant.threads.delete.confirm")}
              danger
              onPress={() => {
                const item = menu.item;
                setMenu(null);
                setPendingDelete(item);
              }}
            />
          </View>
        </>
      ) : null}

      <RenameThreadDialog
        visible={pendingRename !== null}
        initialTitle={pendingRename?.title ?? ""}
        title={t("assistant.threads.rename")}
        body={t("assistant.threads.renameBody")}
        placeholder={t("assistant.threads.untitled")}
        confirmLabel={t("assistant.threads.renameSave")}
        cancelLabel={t("assistant.threads.delete.cancel")}
        onCancel={() => setPendingRename(null)}
        onConfirm={confirmRename}
      />

      {/* Derselbe Dialog wie beim Leeren des Suchverlaufs und im
          Benachrichtigungs-Blatt — kein eigenes Modal. Er liegt in einem eigenen
          Fenster und ist damit unabhängig davon, wo die Schublade im Baum
          hängt. */}
      <ClearSearchHistoryAlert
        visible={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title={t("assistant.threads.delete.title")}
        message={t("assistant.threads.delete.body")}
        confirmLabel={t("assistant.threads.delete.confirm")}
        cancelLabel={t("assistant.threads.delete.cancel")}
      />
    </View>
  );
}

/**
 * Wo die Schrift von „Profil" unter der Oberkante der unteren Leiste beginnt:
 * ihr Abstand nach oben (`sectionLabel.paddingTop`) plus der Weißraum über den
 * Großbuchstaben (bei 13 Punkt rund 4). Roh — das Stilblatt skaliert.
 */
const PROFILE_INK_TOP = SPACE.lg + 4;

const styles = scaledStyles({
  /** `width` kommt zur Laufzeit dazu — sie hängt an der Bildschirmbreite. */
  column: { flex: 1 },

  /** `paddingTop` kommt zur Laufzeit dazu (sichere Fläche + TOPBAR_TOP). */
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: GUTTER,
    paddingBottom: SPACE.lg,
  },
  /** Die Überschrift nimmt den Platz bis zum X. */
  headingWrap: { flex: 1 },
  /**
   * Freistehendes X am rechten Bildschirmrand — `top` kommt zur Laufzeit dazu.
   *
   * Die 44er-Fläche entsteht über Innenabstand; ein `hitSlop` hilft nicht
   * gegen Ansichten, die darüber liegen. Der negative Außenabstand rechts
   * setzt das Zeichen selbst wieder auf GUTTER, ohne die Fläche zu verkleinern.
   */
  /**
   * Innenabstand statt `hitSlop` für die 44er-Fläche, negativer Außenabstand
   * hebt sie im Layout wieder auf — die Zeile wird dadurch nicht höher und das
   * Zeichen wandert nicht.
   */
  closeBtn: {
    padding: CLOSE_PAD,
    margin: -CLOSE_PAD,
    alignItems: "center",
    justifyContent: "center",
  },

  /**
   * Die Maße einer Karte — 1:1 die der Verlaufs-Karten im Landingscreen
   * (`components/home/RecentCard.tsx`): Radius 16, 16 zur Seite, 14 nach oben
   * und unten, 12 zwischen Zeichen und Text, 8 zwischen zwei Karten.
   *
   * OHNE Kante: Die Karten trennen sich allein über die Fläche vom Grund der
   * Schublade (`s2` auf `s3`). Eine Umrandung stünde hier doppelt — und der
   * übliche Wert der App (`border` = #212123) ist ohnehin genau die Farbe des
   * Untergrunds, also gar keine Kante.
   */
  nav: { paddingHorizontal: GUTTER, paddingTop: SPACE.xs, gap: CARD_GAP },
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingHorizontal: SPACE.lg,
    paddingVertical: 16,
    borderRadius: 16,
  },
  /**
   * `flexShrink` und NICHT `flex: 1`.
   *
   * Mit `flex: 1` bekommt die Beschriftung die Grundbreite 0 und lebt nur noch
   * davon, dass die Zeile wirklich waagerecht liegt. Schrumpfen reicht hier
   * völlig — der Text soll kürzen, wenn es eng wird, nicht den Rest wegdrücken.
   */
  navLabel: { flexShrink: 1, fontSize: 15, fontWeight: "600", color: C.white },

  list: { flex: 1 },
  listContent: {
    /**
     * Wächst auf die volle Höhe der Liste: Ohne Zeilen steht der leere Zustand
     * bzw. der Lader damit mittig im freien Teil der Schublade statt oben
     * („Ladeanimationen immer mittig", 04.11.2026). Mit Zeilen ändert es nichts.
     */
    flexGrow: 1,
    /** Die Überschrift steht jetzt außerhalb und bringt ihren Abstand mit. */
    paddingTop: 0,
    paddingHorizontal: GUTTER,
    /** Luft unten: Der letzte Eintrag soll nicht auf der Kante kleben. */
    paddingBottom: SPACE.xxxl,
  },

  /**
   * Die Hülle trägt Rundung und Beschnitt, die Karte darin wandert.
   *
   * Ohne `overflow: hidden` liefe die Karte beim Wischen über den linken Rand
   * hinaus; mit ihm verschwindet sie sauber unter der Rundung.
   */
  rowWrap: { borderRadius: 16, overflow: "hidden", marginBottom: CARD_GAP },
  deleteZone: {
    position: "absolute",
    top: 0,
    // Erst ab hier — sonst schimmert Rot durch die Kantenglättung der linken
    // Ecken. Aufgedeckt wird links davon ohnehin nie etwas.
    left: 24,
    right: 0,
    bottom: 0,
    backgroundColor: "#E5484D",
    borderRadius: 16,
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  deleteBtn: { width: DELETE_WIDTH, height: "100%", alignItems: "center", justifyContent: "center" },

  /** Dieselbe Karte wie im Block darüber — es ist dieselbe Art Zeile. */
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingHorizontal: SPACE.lg,
    paddingVertical: 16,
    borderRadius: 16,
  },
  rowText: { flex: 1, gap: 4 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: SPACE.xs },
  /** `flexShrink`, damit das Anheft-Zeichen nicht vom langen Titel
   *  hinausgedrängt wird. */
  rowTitle: { flexShrink: 1, fontSize: 15, fontWeight: "600", color: C.white },

  spinner: { paddingTop: SPACE.xl },
  /**
   * Ohne Chats (laden, leer, Fehler, abgemeldet): Die Liste wächst auf volle
   * Höhe, OHNE den unteren Rand der Zeilen — sonst stünde alles um dessen
   * Hälfte zu hoch.
   */
  listContentEmpty: { flexGrow: 1, paddingHorizontal: GUTTER },
  /**
   * Mittig zwischen den SICHTBAREN Kanten: der Unterkante von „Geplant" und
   * der Schrift von „Profil" (05.11.2026: der Lader stand gut 40 Punkte zu
   * hoch). Die Liste endet an der Oberkante der unteren Leiste; deren
   * Beschriftung beginnt erst `PROFILE_INK_TOP` tiefer. Um genau so viel
   * reicht die Fläche nach unten über die Liste hinaus — beschnitten wird
   * dort nichts, der Inhalt steht ja in der Mitte.
   */
  loaderArea: {
    flex: 1,
    minHeight: 240,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: -PROFILE_INK_TOP,
  },
  /** Der leere Zustand ebenso. */
  emptyCenter: { flex: 1, justifyContent: "center", marginBottom: -PROFILE_INK_TOP },

  /** Abschnitts-Beschriftung — dieselbe zweite Textebene wie überall (13/grau),
   *  nur fett. Eine eigene Schriftgröße dafür gibt es in der App nicht. */
  sectionWrap: { paddingHorizontal: GUTTER },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: C.gray,
    paddingHorizontal: SPACE.xs,
    /** Luft nach OBEN trennt den Abschnitt vom Block darüber — nach unten
     *  reicht wenig, die Überschrift gehört zu den Zeilen darunter. */
    paddingTop: SPACE.lg,
    paddingBottom: TITLE_GAP,
  },

  /** `left`/`top` kommen zur Laufzeit — sie hängen am Berührungspunkt. */
  menu: {
    position: "absolute",
    width: MENU_W,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    paddingVertical: SPACE.sm,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingHorizontal: SPACE.lg,
    paddingVertical: SPACE.md,
  },
  menuLabel: { flex: 1, fontSize: 15, fontWeight: "600", color: C.white },
  /** Der Trenner vor dem Löschen: `borderWidth` wird nicht skaliert, eine
   *  Linie über die Höhe schon — deshalb eine Fläche und keine Kante. */
  menuRule: { height: 1, marginVertical: SPACE.xs, marginHorizontal: SPACE.lg },

  /**
   * Die Leiste selbst trägt die Ränder, die Karten darin nur ihre Innenmaße —
   * so bleibt der Abstand zwischen ihnen unabhängig von ihren Breiten.
   */
  /**
   * Der untere Stapel — `width` und `bottom` kommen zur Laufzeit.
   *
   * Er liegt in der Breite der SPALTE, nicht des Bildschirms: Die beiden Karten
   * sollen genauso breit sein wie die Zeilen darüber. Und er sitzt nicht am
   * Bildschirmrand, sondern auf der Unterkante des geschrumpften Bo-Screens —
   * siehe `bottomGap`.
   */
  bottomBar: {
    position: "absolute",
    left: 0,
    paddingHorizontal: GUTTER,
    gap: CARD_GAP,
  },
  /**
   * Profil und Angebot sind Karten wie die Zeilen darüber — gleiche Fläche,
   * gleicher Radius, gleiche Innenabstände.
   */
  bottomLabel: { paddingBottom: 0 },

  /** Beide tragen die Maße der Zeilen oben — es sind dieselben Karten. */
  account: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingHorizontal: SPACE.lg,
    paddingVertical: 16,
    borderRadius: 16,
  },
  claim: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingHorizontal: SPACE.lg,
    paddingVertical: 16,
    borderRadius: 16,
  },
  claimLabel: { flexShrink: 1, fontSize: 15, fontWeight: "600", color: C.white },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  avatarFallback: { alignItems: "center", justifyContent: "center" },
  avatarInitials: { fontSize: 14, fontWeight: "700" },
  /** Wie `rowText` der Chat-Zeilen darüber — gleiche Zeile, gleicher Abstand. */
  accountText: { flexShrink: 1, gap: SPACE.xs },
  accountName: { fontSize: 14, fontWeight: "600", color: C.white },
  accountMail: { fontSize: 12, color: C.gray },
});
