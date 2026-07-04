import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  BackHandler,
  Keyboard,
  Platform,
  View,
  Text,
  Pressable,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { X, Navigation, Plane, Train, Bus, Ship, Flag } from "lucide-react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Location, TravelMode } from "@/types/search";
import { fetchLocations } from "@/lib/api/client";
import { useT } from "@/lib/i18n/useT";
import { SearchBar } from "@/components/SearchBar";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useSearchStore } from "@/stores/searchStore";
import { useAccent } from "@/lib/theme/accent";
import { SaveStarButton } from "@/components/surroundings/SaveStarButton";

type Field = "from" | "to";

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (loc: Location) => void;
  field?: Field;
  mode: TravelMode | "ALL";
  recent?: Location[];
  suggested?: Location[];
  /** Optional Header-Titel — überschreibt den feldbasierten Default
   *  ("Where from?" / "Where to?"). */
  title?: string;
  /** Optionales Leading-Label im Such-Input — überschreibt den feldbasierten
   *  Default ("From" / "To"). Leerstring blendet das Label komplett aus. */
  leadingLabel?: string;
  /** Override-Placeholder für die Search-Bar (i18n-Key). */
  placeholderKey?: string;
}

const MODE_ICON = { FLIGHT: Plane, TRAIN: Train, BUS: Bus, CRUISE: Ship } as const;

export function LocationPicker({
  visible,
  onClose,
  onSelect,
  field = "from",
  mode,
  recent = [],
  suggested = [],
  title,
  leadingLabel,
  placeholderKey = "search.location.placeholder",
}: Props) {
  const t = useT();
  const accent = useAccent();
  const [query, setQuery] = useState("");
  const debounced = useDebounce(query, 200);
  const savedStations = useSearchStore((s) => s.savedStations);
  // Im ALL-Mode zeigen wir alle gespeicherten Stationen, sonst nur die zum
  // aktuellen Mode passenden. ALL-Type-Stationen (z.B. Cities) sind mode-
  // agnostisch und werden überall mit angezeigt.
  const filteredSaved = useMemo(() => {
    if (mode === "ALL") return savedStations;
    return savedStations.filter((s) => s.type === mode || s.type === "ALL");
  }, [savedStations, mode]);

  // Gespeicherte Stationen erscheinen NUR unter „Gespeichert" — aus den
  // Vorschlägen und Recents ausblenden, sonst steht dieselbe Station doppelt
  // in der Liste (z.B. direkt nach dem Speichern aus den Vorschlägen heraus).
  const savedCodes = useMemo(() => new Set(savedStations.map((s) => s.code)), [savedStations]);
  const visibleRecent = useMemo(
    () => recent.filter((l) => !savedCodes.has(l.code)),
    [recent, savedCodes],
  );
  const visibleSuggested = useMemo(
    () => suggested.filter((l) => !savedCodes.has(l.code)),
    [suggested, savedCodes],
  );

  useEffect(() => {
    if (!visible) {
      setQuery("");
      // Keyboard SOFORT mit dem Slide-Out runterfahren — sonst bleibt es
      // offen stehen und gibt den Blick auf die (nativ übers Keyboard
      // gehobene) Bottom-Tab-Bar frei. Deckt alle Close-Pfade ab (X,
      // Hardware-Back, Auswahl).
      Keyboard.dismiss();
    }
  }, [visible]);

  const { data: results, isLoading, isError, error } = useQuery({
    queryKey: ["locations", mode, debounced],
    queryFn: () => fetchLocations(debounced, mode),
    enabled: visible && debounced.trim().length >= 2,
    staleTime: 5 * 60 * 1000,
    // Mehrfacher Retry mit kurzem Backoff — verhindert dass ein einzelner
    // Cold-Start-Timeout den Search-Flow blockiert (User musste sonst über
    // Tab-Switch das Component-Remount erzwingen damit's wieder klappt).
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
    // Wenn der Picker geschlossen + wieder geöffnet wird, frischen Versuch
    // starten (auch wenn das vorherige Ergebnis ein Error war).
    refetchOnMount: "always",
  });

  const showSearchResults = debounced.trim().length >= 2;

  // Slide-Animation via Reanimated.View statt RN Modal. Vorher hat der
  // Modal-Native-Layer auf Android beim ERSTEN Open eine Dialog-Init
  // gestartet → spürbares Input-Lag. Jetzt ist der Overlay IMMER mounted
  // (nur translateY/opacity-getrieben), erster Tap → null Cold-Start.
  const { height: screenH } = useWindowDimensions();
  const offset = useSharedValue(screenH);
  const opacity = useSharedValue(0);

  // Pre-warm: einmaliger no-op withTiming am Mount damit Reanimated v4
  // die Worklets JIT-kompiliert BEVOR der User zum ersten Mal tippt.
  useEffect(() => {
    offset.value = withTiming(screenH, { duration: 1 });
    opacity.value = withTiming(0, { duration: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    cancelAnimation(offset);
    cancelAnimation(opacity);
    if (visible) {
      offset.value = withTiming(0, { duration: 280, easing: Easing.out(Easing.cubic) });
      // Opacity steuert NUR den Backdrop (siehe backdropStyle). Sync mit
      // offset-Duration damit Backdrop in derselben Zeit ein-/ausfadet wie
      // der Picker rein-/rausslidet.
      opacity.value = withTiming(1, { duration: 280 });
    } else {
      offset.value = withTiming(screenH, { duration: 280, easing: Easing.in(Easing.cubic) });
      opacity.value = withTiming(0, { duration: 280 });
    }
  }, [visible, offset, opacity, screenH]);

  // Picker selbst NUR translateY, KEINE Opacity — sonst fadet er beim
  // Slide-Out (160ms) schneller weg als er translatet (280ms) und der
  // User sieht nur einen Disappear-Effekt statt einem Slide. Mit reinem
  // translateY ist der Picker während der gesamten 280ms voll sichtbar
  // bis er off-screen ist.
  const overlayStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));

  // Backdrop-Style — opacity fadet von 0→1 wenn Picker visible.
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  // Inner content (FlatList, SearchBar) wird IMMER gemountet — analog zum
  // DatePicker. Mit always-mount ist das Inner-Tree bereits zu App-Start
  // gerendert → Slide-In startet sauber ohne Mount-Konkurrenz.
  const hasOpened = true;

  // BackHandler: hardware-back/Geste schließt den Picker statt den ganzen
  // SearchHero zu verlassen. Vorher hat das Modal das automatisch gemacht
  // via onRequestClose — jetzt müssen wir's manuell intercepten.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true; // prevent default
    });
    return () => sub.remove();
  }, [visible, onClose]);

  const handleSelect = useCallback(
    (loc: Location) => {
      onSelect(loc);
      onClose();
    },
    [onSelect, onClose],
  );

  // Stabile renderItem-Referenz für die FlatList — zusammen mit dem memo auf
  // PickerRow bailen alle Zeilen beim visible-Flip des Pickers aus statt im
  // Animations-Start-Commit neu zu rendern.
  const renderResultRow = useCallback(
    ({ item }: { item: Location }) => (
      <PickerRow loc={item} onSelect={handleSelect} />
    ),
    [handleSelect],
  );
  const keyExtractor = useCallback((i: Location) => i.code, []);

  return (
    <>
      {/* Backdrop — abdunkelt SearchHero hinter dem Picker während Slide-In.
          zIndex 9998 = unter dem Picker, parallel zum DatePicker-Pattern. */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFillObject,
          { zIndex: 9998, backgroundColor: "rgba(0,0,0,0.75)" },
          backdropStyle,
        ]}
      />
      {/* Slide-Wrap mit elevation 32 → Android hebt diesen View auf einen
          eigenen Hardware-Layer. translateY läuft damit GPU-only und der
          Compositor muss NICHT pro Frame den ganzen Subtree (Searchbar,
          FlatList, alle Rows) neu rasterisieren. Ohne elevation hatten wir
          spürbare Frame-Drops während des Slide-Ins. Zusätzlich
          renderToHardwareTextureAndroid + shouldRasterizeIOS als Belt-and-
          Suspenders gegen Sub-Pixel-Jitter. */}
      <Animated.View
      collapsable={false}
      renderToHardwareTextureAndroid={Platform.OS === "android"}
      shouldRasterizeIOS={Platform.OS === "ios"}
      pointerEvents={visible ? "auto" : "none"}
      style={[
        StyleSheet.absoluteFillObject,
        { backgroundColor: "#1A1A1A", zIndex: 9999, elevation: 32 },
        overlayStyle,
      ]}
    >
        {hasOpened ? (
        <>
        <View className="flex-row items-center gap-3 px-5 pt-14 pb-4">
          <RippleTouch
            hitSlop={12}
            onPress={onClose}
            accessibilityLabel={t("search.close")}
            borderless
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <X color="#E5E7EB" size={26} />
          </RippleTouch>
          <Text className="text-2xl font-semibold text-white">
            {title ?? t(field === "from" ? "search.location.title.from" : "search.location.title.to")}
          </Text>
        </View>

        <View className="px-5 pb-3">
          <SearchBar
            value={query}
            onChangeText={setQuery}
            placeholderKey={placeholderKey}
            leadingLabel={
              leadingLabel === undefined
                ? t(field === "from" ? "search.from" : "search.to")
                : leadingLabel || undefined
            }
            showMic={false}
            // autoFocus togglet mit visible — Overlay ist immer mounted,
            // aber Keyboard öffnet nur wenn das Overlay sichtbar wird.
            // Mit autoFocusDelay startet das Keyboard 380ms nach visible→
            // true, also direkt nach der Slide-In-Animation.
            autoFocus={visible}
            autoFocusDelay={380}
          />
        </View>

        {showSearchResults ? (
          isLoading ? (
            <View className="py-8 items-center">
              <ActivityIndicator color={accent.solid} />
            </View>
          ) : isError ? (
            <View className="px-5 py-6">
              <Text className="text-sm font-semibold text-pink-400 mb-1">
                Connection error
              </Text>
              <Text className="text-xs text-gray-500" numberOfLines={3}>
                {error instanceof Error ? error.message : "Could not reach the server."}
              </Text>
            </View>
          ) : (
            <FlatList
              data={results ?? []}
              keyExtractor={keyExtractor}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}
              renderItem={renderResultRow}
              // Virtualisierung — bei langen Autocomplete-Listen (z.B. die 25
              // Treffer für „Berlin") spart das CPU/Memory und macht's smooth.
              windowSize={5}
              initialNumToRender={10}
              maxToRenderPerBatch={8}
              removeClippedSubviews
              ListEmptyComponent={
                <Text className="text-sm text-gray-500 mt-6">
                  No matches.
                </Text>
              }
            />
          )
        ) : (
          <FlatList
            data={[]}
            keyExtractor={() => "_"}
            renderItem={null as never}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}
            ListHeaderComponent={
              <>
                <RippleTouch
                  className="flex-row items-center gap-4 py-4"
                  style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                  <Navigation color="#E5E7EB" size={22} />
                  <View>
                    <Text className="text-base font-semibold text-white">
                      {t("search.location.current")}
                    </Text>
                    <Text className="text-sm text-gray-500 mt-0.5">
                      {t("search.location.usecurrent")}
                    </Text>
                  </View>
                </RippleTouch>

                {filteredSaved.length > 0 && (
                  <>
                    <Text className="text-base font-bold text-white mt-4 mb-2">
                      {t("search.location.saved")}
                    </Text>
                    {filteredSaved.map((loc) => (
                      <PickerRow key={`saved-${loc.code}`} loc={loc} onSelect={handleSelect} />
                    ))}
                  </>
                )}

                {visibleRecent.length > 0 && (
                  <>
                    <Text className="text-base font-bold text-white mt-4 mb-2">
                      {t("search.location.recent")}
                    </Text>
                    {visibleRecent.map((loc) => (
                      <PickerRow key={loc.code} loc={loc} onSelect={handleSelect} />
                    ))}
                  </>
                )}

                {visibleSuggested.length > 0 && (
                  <>
                    <Text className="text-base font-bold text-white mt-4 mb-2">
                      {t("search.location.suggested")}
                    </Text>
                    {visibleSuggested.map((loc) => (
                      <PickerRow key={loc.code} loc={loc} onSelect={handleSelect} suggested />
                    ))}
                  </>
                )}
              </>
            }
          />
        )}
        </>
        ) : null}
      </Animated.View>
    </>
  );
}

// Icon pro Result aus seinem Typ ableiten — HAFAS liefert für „Train" auch
// Bushaltestellen (type=BUS), Cities sind type=ALL → Flag.
function iconFor(loc: Location) {
  if (loc.type === "ALL") return Flag;
  return MODE_ICON[loc.type];
}

/** Toggle-Button für „Station speichern" — dieselbe SaveStarButton-Komponente
 *  wie im StopDetailSheet (Gold-Verlaufs-Stern + Pop + Funken), damit gespeicherte
 *  Stationen überall identisch aussehen. Der innere Pressable konsumiert den
 *  Tap, sodass der äußere Row-onPress (= Selection) NICHT mehr feuert. */
function SaveStar({ loc }: { loc: Location }) {
  const saved = useSearchStore((s) => s.savedStations.some((x) => x.code === loc.code));
  const toggle = useSearchStore((s) => s.toggleSavedStation);
  return <SaveStarButton size={32} starSize={20} saved={saved} onChange={() => toggle(loc)} />;
}

/** Eine Zeile im Picker (Ergebnis / Gespeichert / Zuletzt / Vorschlag).
 *
 *  memo + stabile Props (loc-Referenz aus useMemo/Query, onSelect via
 *  useCallback): Der Picker ist always-mounted und re-rendert bei jedem
 *  visible-Flip — OHNE memo würden dabei alle ~20 Zeilen (je mit SVG-Icon +
 *  SaveStarButton) im selben Fabric-Commit neu gerendert, exakt am Start
 *  der Slide-Animation → sichtbares Ruckeln beim Öffnen/Schließen. */
const PickerRow = memo(function PickerRow({
  loc,
  onSelect,
  suggested = false,
}: {
  loc: Location;
  onSelect: (loc: Location) => void;
  /** Vorschlags-Variante: Länder (type ALL) zeigen „Country" als Subtitle. */
  suggested?: boolean;
}) {
  const Icon = iconFor(loc);
  const subtitle =
    suggested && loc.type === "ALL" ? "Country" : loc.country || loc.city;
  return (
    <RippleTouch
      onPress={() => onSelect(loc)}
      className="flex-row items-center gap-4 py-3"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <Icon color="#E5E7EB" size={20} />
      <View className="flex-1">
        <Text className="text-base font-semibold text-white">{loc.label}</Text>
        <Text className="text-sm text-gray-500 mt-0.5">{subtitle}</Text>
      </View>
      <SaveStar loc={loc} />
    </RippleTouch>
  );
});

function useDebounce<T>(value: T, delay: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), delay);
    return () => clearTimeout(h);
  }, [value, delay]);
  return useMemo(() => v, [v]);
}
