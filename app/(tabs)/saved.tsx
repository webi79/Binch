import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView } from "react-native";
import type { SavedTrip } from "@/types/saved";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIsFocused } from "@react-navigation/native";
import { Plus, ChevronRight } from "lucide-react-native";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore, type SearchStoreState } from "@/stores/searchStore";
import { ResultCard } from "@/components/results/ResultCard";
import { TicketCard } from "@/components/saved/TicketCard";
import { AddTicketModal } from "@/components/saved/AddTicketModal";
import { EmptyState } from "@/components/saved/EmptyState";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { SlidingPanels } from "@/components/ui/SlidingPanels";
import { useAccent } from "@/lib/theme/accent";

/**
 * Subscribe-only-when-focused. Subscribt nur an `useSearchStore` wenn
 * `isFocused` true ist — andere Tabs sind permanent gemountet (native
 * bottom tabs), und ihre Store-Subscriptions würden sonst bei jedem Save
 * für unsichtbare Tabs feuern und Re-Renders triggern.
 */
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
 * Skeleton-Karte mit ähnlicher Höhe wie eine ResultCard. Während der Saved-
 * Tab nach Focus für ~220ms aufwacht, zeigen wir Skelett-Boxen statt die
 * echten ResultCards zu mounten — die messen sich sonst alle gleichzeitig
 * im Tab-Switch-Frame, was visuell als "Karten springen rum" rüberkommt.
 */
function SkeletonCard() {
  return (
    <View className="mx-4 mb-3">
      <View
        style={{
          height: 132,
          borderRadius: 18,
          backgroundColor: "#242425",
          borderWidth: 1,
          borderColor: "#2E2E30",
        }}
      />
    </View>
  );
}

function SkeletonList() {
  return (
    <View>
      <View
        style={{
          height: 14,
          width: 80,
          marginLeft: 20,
          marginTop: 2,
          marginBottom: 12,
          borderRadius: 4,
          backgroundColor: "#242425",
        }}
      />
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </View>
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
  const [tab, setTab] = useState<Tab>("trips");
  const [showModal, setShowModal] = useState(false);
  const isFocused = useIsFocused();

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

  // Defer-Pattern für die ResultCard/TicketCard-Listen: NUR beim ERSTEN
  // Focus (= erster Besuch des Saved-Tabs) zeigen wir 220ms ein Skelett.
  const [listReady, setListReady] = useState(false);
  useEffect(() => {
    if (!isFocused || listReady) return;
    const id = setTimeout(() => setListReady(true), 220);
    return () => clearTimeout(id);
  }, [isFocused, listReady]);

  const today = useMemo(() => savedTrips.filter((tr) => isToday(tr.savedAt)), [savedTrips]);
  const earlier = useMemo(() => savedTrips.filter((tr) => !isToday(tr.savedAt)), [savedTrips]);

  const ticketCountKey = tickets.length === 1 ? "saved.tickets.count.one" : "saved.tickets.count.many";
  const ticketCountLine = t(ticketCountKey).replace("{count}", String(tickets.length));

  return (
    <SafeAreaView className="flex-1 bg-[#1A1A1A]" edges={["top"]}>
      <View className="px-4 pt-6">
        <Text className="text-[26px] font-black text-white tracking-tight">
          Saved
        </Text>
      </View>
      <View className="px-4 pt-4 pb-4">
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
        {!listReady ? (
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingBottom: 98 }}
            showsVerticalScrollIndicator={false}
          >
            <SkeletonList />
          </ScrollView>
        ) : savedTrips.length === 0 ? (
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingBottom: 98 }}
            showsVerticalScrollIndicator={false}
          >
            <EmptyState tab="trips" />
          </ScrollView>
        ) : (
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingBottom: 98, paddingHorizontal: 16 }}
            showsVerticalScrollIndicator={false}
          >
            {today.length > 0 && (
              <>
                <Text className="text-[15px] font-semibold text-white mt-1 mb-2.5">
                  {t("saved.section.today")}
                </Text>
                {today.map((tr) => (
                  <View key={tr.id} className="mb-3">
                    <ResultCard result={tr} passengers={tr.passengers} />
                  </View>
                ))}
              </>
            )}
            {earlier.length > 0 && (
              <>
                <Text className="text-[15px] font-semibold text-white mt-1 mb-2.5">
                  {t("saved.section.earlier")}
                </Text>
                {earlier.map((tr) => (
                  <View key={tr.id} className="mb-3">
                    <ResultCard result={tr} passengers={tr.passengers} />
                  </View>
                ))}
              </>
            )}
          </ScrollView>
        )}

        {/* TICKETS */}
        {!listReady ? (
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingBottom: 98 }}
            showsVerticalScrollIndicator={false}
          >
            <SkeletonList />
          </ScrollView>
        ) : (
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingBottom: 98 }}
            showsVerticalScrollIndicator={false}
          >
            <RippleTouch
              onPress={() => setShowModal(true)}
              className="flex-row items-center rounded-2xl mx-4 mb-3.5 p-3.5"
              style={{ backgroundColor: accent.subtle, borderWidth: 1, borderColor: accent.border }}
            >
              <View className="w-8 h-8 rounded-[9px] items-center justify-center mr-2.5" style={{ backgroundColor: accent.subtle }}>
                <Plus size={18} color={accent.solid} strokeWidth={2.5} />
              </View>
              <Text className="flex-1 text-sm font-semibold" style={{ color: accent.solid }}>
                {t("saved.tickets.add")}
              </Text>
              <ChevronRight size={16} color={accent.solid} />
            </RippleTouch>

            {tickets.length === 0 ? (
              <EmptyState tab="tickets" />
            ) : (
              <>
                <Text className="text-[13px] text-[#56565C] font-medium mx-5 mb-2.5">
                  {ticketCountLine}
                </Text>
                {tickets.map((tk) => (
                  <TicketCard key={tk.id} ticket={tk} />
                ))}
              </>
            )}
          </ScrollView>
        )}
      </SlidingPanels>

      <AddTicketModal
        visible={showModal}
        onClose={() => setShowModal(false)}
        onAdd={addTicket}
      />
    </SafeAreaView>
  );
}
