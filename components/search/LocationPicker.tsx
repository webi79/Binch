import { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, Modal, FlatList, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { X, Navigation, Plane, Train, Bus, Ship, Flag, Star } from "lucide-react-native";
import Animated, { SlideInDown, SlideOutDown } from "react-native-reanimated";
import { Location, TravelMode } from "@/types/search";
import { fetchLocations } from "@/lib/api/client";
import { useT } from "@/lib/i18n/useT";
import { SearchBar } from "@/components/SearchBar";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useSearchStore } from "@/stores/searchStore";
import { haptic } from "@/lib/haptics";

const SAVED_GOLD = "#FFC107";

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

  useEffect(() => {
    if (!visible) setQuery("");
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

  const handleSelect = (loc: Location) => {
    onSelect(loc);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="none"
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View style={[StyleSheet.absoluteFillObject, { backgroundColor: "#1A1A1A" }]} />
      <Animated.View
        entering={SlideInDown.duration(350)}
        exiting={SlideOutDown.duration(350)}
        style={[StyleSheet.absoluteFillObject, { backgroundColor: "#1A1A1A" }]}
      >
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
            autoFocus
          />
        </View>

        {showSearchResults ? (
          isLoading ? (
            <View className="py-8 items-center">
              <ActivityIndicator color="#7FEA4D" />
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
              keyExtractor={(i) => i.code}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}
              renderItem={({ item }) => (
                <LocationRow loc={item} onPress={() => handleSelect(item)} />
              )}
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
                      <RecentRow key={`saved-${loc.code}`} loc={loc} onPress={() => handleSelect(loc)} />
                    ))}
                  </>
                )}

                {recent.length > 0 && (
                  <>
                    <Text className="text-base font-bold text-white mt-4 mb-2">
                      {t("search.location.recent")}
                    </Text>
                    {recent.map((loc) => (
                      <RecentRow key={loc.code} loc={loc} onPress={() => handleSelect(loc)} />
                    ))}
                  </>
                )}

                {suggested.length > 0 && (
                  <>
                    <Text className="text-base font-bold text-white mt-4 mb-2">
                      {t("search.location.suggested")}
                    </Text>
                    {suggested.map((loc) => (
                      <SuggestedRow
                        key={loc.code}
                        loc={loc}
                        onPress={() => handleSelect(loc)}
                      />
                    ))}
                  </>
                )}
              </>
            }
          />
        )}
      </Animated.View>
    </Modal>
  );
}

// Icon pro Result aus seinem Typ ableiten — HAFAS liefert für „Train" auch
// Bushaltestellen (type=BUS), Cities sind type=ALL → Flag.
function iconFor(loc: Location) {
  if (loc.type === "ALL") return Flag;
  return MODE_ICON[loc.type];
}

/** Toggle-Button für „Station speichern". Inner-RippleTouch konsumiert den
 *  Tap, sodass der äußere Row-onPress (= Selection) NICHT mehr feuert.
 *  Gold + filled = gespeichert, weiß + outline = nicht gespeichert. */
function SaveStar({ loc }: { loc: Location }) {
  const saved = useSearchStore((s) => s.savedStations.some((x) => x.code === loc.code));
  const toggle = useSearchStore((s) => s.toggleSavedStation);
  return (
    <RippleTouch
      onPress={() => {
        haptic("button");
        toggle(loc);
      }}
      hitSlop={8}
      borderless
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, padding: 4 })}
      accessibilityLabel={saved ? "Unsave station" : "Save station"}
    >
      <Star
        color={saved ? SAVED_GOLD : "#FFFFFF"}
        fill={saved ? SAVED_GOLD : "transparent"}
        size={20}
      />
    </RippleTouch>
  );
}

function LocationRow({ loc, onPress }: { loc: Location; onPress: () => void }) {
  const Icon = iconFor(loc);
  return (
    <RippleTouch
      onPress={onPress}
      className="flex-row items-center gap-4 py-3"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <Icon color="#E5E7EB" size={20} />
      <View className="flex-1">
        <Text className="text-base font-semibold text-white">{loc.label}</Text>
        <Text className="text-sm text-gray-500 mt-0.5">
          {loc.country || loc.city}
        </Text>
      </View>
      <SaveStar loc={loc} />
    </RippleTouch>
  );
}

function RecentRow({ loc, onPress }: { loc: Location; onPress: () => void }) {
  const Icon = iconFor(loc);
  return (
    <RippleTouch
      onPress={onPress}
      className="flex-row items-center gap-4 py-3"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <Icon color="#E5E7EB" size={20} />
      <View className="flex-1">
        <Text className="text-base font-semibold text-white">{loc.label}</Text>
        <Text className="text-sm text-gray-500 mt-0.5">
          {loc.country || loc.city}
        </Text>
      </View>
      <SaveStar loc={loc} />
    </RippleTouch>
  );
}

function SuggestedRow({
  loc,
  onPress,
}: {
  loc: Location;
  onPress: () => void;
}) {
  const Icon = iconFor(loc);
  const subtitle =
    loc.type === "ALL"
      ? "Country"
      : `${loc.country ? loc.country : loc.city}`;
  return (
    <RippleTouch
      onPress={onPress}
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
}

function useDebounce<T>(value: T, delay: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), delay);
    return () => clearTimeout(h);
  }, [value, delay]);
  return useMemo(() => v, [v]);
}
