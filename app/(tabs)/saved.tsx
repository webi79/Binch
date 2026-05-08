import { useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Plus, ChevronRight } from "lucide-react-native";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore } from "@/stores/searchStore";
import { ResultCard } from "@/components/results/ResultCard";
import { TicketCard } from "@/components/saved/TicketCard";
import { AddTicketModal } from "@/components/saved/AddTicketModal";
import { EmptyState } from "@/components/saved/EmptyState";
import { RippleTouch } from "@/components/ui/RippleTouch";

type Tab = "trips" | "tickets";

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
  const [tab, setTab] = useState<Tab>("trips");
  const [showModal, setShowModal] = useState(false);

  const savedTrips = useSearchStore((s) => s.savedTrips);
  const tickets = useSearchStore((s) => s.tickets);
  const addTicket = useSearchStore((s) => s.addTicket);

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
        <View className="flex-row bg-[#242425] rounded-2xl p-1">
          {(["trips", "tickets"] as const).map((id) => {
            const active = tab === id;
            return (
              <Pressable
                key={id}
                onPress={() => setTab(id)}
                className="flex-1 py-2.5 rounded-xl items-center justify-center"
                style={
                  active
                    ? {
                        backgroundColor: "#7FEA4D",
                        ...Platform.select({
                          ios: {
                            shadowColor: "#7FEA4D",
                            shadowOpacity: 0.3,
                            shadowRadius: 8,
                            shadowOffset: { width: 0, height: 2 },
                          },
                          android: { elevation: 4 },
                        }),
                      }
                    : undefined
                }
              >
                <Text
                  className={
                    active
                      ? "text-sm font-bold text-black"
                      : "text-sm font-medium text-[#8A8A90]"
                  }
                >
                  {id === "trips" ? t("saved.tab.trips") : t("saved.tab.tickets")}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 98 }}
        showsVerticalScrollIndicator={false}
      >
        {tab === "trips" ? (
          savedTrips.length === 0 ? (
            <EmptyState tab="trips" />
          ) : (
            <>
              {today.length > 0 ? (
                <>
                  <Text className="text-[15px] font-semibold text-white mx-5 mt-1 mb-2.5">
                    {t("saved.section.today")}
                  </Text>
                  {today.map((tr) => (
                    <View key={tr.id} className="mx-4 mb-3">
                      <ResultCard result={tr} passengers={tr.passengers} />
                    </View>
                  ))}
                </>
              ) : null}
              {earlier.length > 0 ? (
                <>
                  <Text className="text-[15px] font-semibold text-white mx-5 mt-1 mb-2.5">
                    {t("saved.section.earlier")}
                  </Text>
                  {earlier.map((tr) => (
                    <View key={tr.id} className="mx-4 mb-3">
                      <ResultCard result={tr} passengers={tr.passengers} />
                    </View>
                  ))}
                </>
              ) : null}
            </>
          )
        ) : (
          <>
            <RippleTouch
              onPress={() => setShowModal(true)}
              className="flex-row items-center bg-[#1A3D26] border border-[rgba(127,234,77,0.25)] rounded-2xl mx-4 mb-3.5 p-3.5"
            >
              <View className="w-8 h-8 rounded-[9px] items-center justify-center mr-2.5" style={{ backgroundColor: "rgba(127,234,77,0.2)" }}>
                <Plus size={18} color="#7FEA4D" strokeWidth={2.5} />
              </View>
              <Text className="flex-1 text-sm font-semibold text-[#7FEA4D]">
                {t("saved.tickets.add")}
              </Text>
              <ChevronRight size={16} color="#7FEA4D" />
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
          </>
        )}
      </ScrollView>

      <AddTicketModal
        visible={showModal}
        onClose={() => setShowModal(false)}
        onAdd={addTicket}
      />
    </SafeAreaView>
  );
}
