import { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, Modal, FlatList, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { X, Search, Navigation, Plane, Train, Bus, Ship, Flag } from "lucide-react-native";
import Animated, { SlideInDown, SlideOutDown } from "react-native-reanimated";
import { Location, TravelMode } from "@/types/search";
import { fetchLocations } from "@/lib/api/client";
import { useT } from "@/lib/i18n/useT";
import { SearchBar } from "@/components/SearchBar";
import { RippleTouch } from "@/components/ui/RippleTouch";

type Field = "from" | "to";

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (loc: Location) => void;
  field: Field;
  mode: TravelMode;
  recent?: Location[];
  suggested?: Location[];
}

const MODE_ICON = { FLIGHT: Plane, TRAIN: Train, BUS: Bus, CRUISE: Ship } as const;

export function LocationPicker({
  visible,
  onClose,
  onSelect,
  field,
  mode,
  recent = [],
  suggested = [],
}: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const debounced = useDebounce(query, 200);

  useEffect(() => {
    if (!visible) setQuery("");
  }, [visible]);

  const { data: results, isLoading, isError, error } = useQuery({
    queryKey: ["locations", mode, debounced],
    queryFn: () => fetchLocations(debounced, mode),
    enabled: visible && debounced.trim().length >= 2,
    staleTime: 5 * 60 * 1000,
    retry: 1,
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
            {t(field === "from" ? "search.location.title.from" : "search.location.title.to")}
          </Text>
        </View>

        <View className="px-5 pb-3">
          <SearchBar
            value={query}
            onChangeText={setQuery}
            placeholderKey="search.location.placeholder"
            leadingLabel={t(field === "from" ? "search.from" : "search.to")}
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
                        mode={mode}
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

function LocationRow({ loc, onPress }: { loc: Location; onPress: () => void }) {
  return (
    <RippleTouch
      onPress={onPress}
      className="flex-row items-center gap-4 py-3"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <Search color="#9CA3AF" size={20} />
      <View className="flex-1">
        <Text className="text-base font-semibold text-white">{loc.label}</Text>
        <Text className="text-sm text-gray-500 mt-0.5">
          {loc.country || loc.city}
        </Text>
      </View>
    </RippleTouch>
  );
}

function RecentRow({ loc, onPress }: { loc: Location; onPress: () => void }) {
  return (
    <RippleTouch
      onPress={onPress}
      className="flex-row items-center gap-4 py-3"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <Search color="#9CA3AF" size={20} />
      <View className="flex-1">
        <Text className="text-base font-semibold text-white">{loc.label}</Text>
        <Text className="text-sm text-gray-500 mt-0.5">
          {loc.country || loc.city}
        </Text>
      </View>
    </RippleTouch>
  );
}

function SuggestedRow({
  loc,
  mode,
  onPress,
}: {
  loc: Location;
  mode: TravelMode;
  onPress: () => void;
}) {
  const Icon = loc.type === "ALL" ? Flag : MODE_ICON[mode];
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
