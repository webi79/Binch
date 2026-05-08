import { useMemo, useState } from "react";
import { View, Text, Pressable, Image, Modal, ScrollView } from "react-native";
import { showAlert } from "@/lib/alert";
import { Plane, TrainFront, Bus, Ship, Trash2, X } from "lucide-react-native";
import { Ticket } from "@/types/saved";
import { TravelMode } from "@/types/search";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore } from "@/stores/searchStore";
import { intlLocale } from "@/lib/i18n/intl";
import { formatTimeInZone, formatDateInZone } from "@/lib/time-format";
import { RippleTouch } from "@/components/ui/RippleTouch";

interface Props {
  ticket: Ticket;
}

const ICON: Record<TravelMode, typeof Plane> = {
  FLIGHT: Plane,
  TRAIN: TrainFront,
  BUS: Bus,
  CRUISE: Ship,
};

const ACCENT_COLOR: Record<TravelMode, string> = {
  FLIGHT: "#2979FF",
  TRAIN: "#FF6D00",
  BUS: "#7B1FA2",
  CRUISE: "#0288D1",
};

function formatDuration(minutes: number | undefined): string {
  if (!minutes) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function TicketCard({ ticket }: Props) {
  const t = useT();
  const locale = useSearchStore((s) => s.locale);
  const removeTicket = useSearchStore((s) => s.removeTicket);
  const [zoom, setZoom] = useState(false);

  const Icon = ICON[ticket.mode];
  const accentColor = ACCENT_COLOR[ticket.mode];

  const departStr = useMemo(
    () => (ticket.departTime ? formatTimeInZone(ticket.departTime, ticket.originTz, intlLocale(locale)) : "—"),
    [ticket.departTime, ticket.originTz, locale]
  );
  const arriveStr = useMemo(
    () => (ticket.arriveTime ? formatTimeInZone(ticket.arriveTime, ticket.destinationTz, intlLocale(locale)) : "—"),
    [ticket.arriveTime, ticket.destinationTz, locale]
  );
  const dateStr = useMemo(
    () => (ticket.departTime ? formatDateInZone(ticket.departTime, ticket.originTz, intlLocale(locale)) : ""),
    [ticket.departTime, ticket.originTz, locale]
  );

  const stopsLabel =
    ticket.stops === 0
      ? t("saved.ticket.nonstop")
      : `${ticket.stops} ${ticket.stops === 1 ? t("results.stop") : t("results.stops")}`;

  const carrierLabel = ticket.flightNumber
    ? `${ticket.carrier ?? ""} ${ticket.flightNumber}`.trim()
    : ticket.carrier ?? ticket.originalName ?? t("saved.modal.title");

  const confirmDelete = () => {
    showAlert(
      t("saved.ticket.delete.title"),
      t("saved.ticket.delete.body").replace("{label}", carrierLabel),
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("common.delete"), style: "destructive", onPress: () => removeTicket(ticket.id) },
      ]
    );
  };

  const ratio = ticket.pageImageRatio && ticket.pageImageRatio > 0 ? ticket.pageImageRatio : 1.4;

  return (
    <View className="bg-[#1F1F20] rounded-2xl border border-[#2A2A2C] mx-4 mb-3 overflow-hidden">
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-[#2E2E30]">
        <View className="flex-row items-center gap-2 flex-1">
          <View className="w-7 h-7 rounded-lg items-center justify-center bg-[#242425]">
            <Icon size={16} color={accentColor} strokeWidth={1.8} />
          </View>
          <Text className="text-[13px] font-bold text-white tracking-wide flex-1" numberOfLines={1}>
            {ticket.carrier ?? ticket.originalName ?? t("saved.modal.title")}
          </Text>
        </View>
        {ticket.flightNumber ? (
          <View className="px-2.5 py-0.5 rounded-full bg-[#242425] ml-2">
            <Text className="text-[11px] font-bold text-white">{ticket.flightNumber}</Text>
          </View>
        ) : null}
      </View>

      {ticket.fromCode && ticket.toCode ? (
        <>
          <View className="flex-row items-center px-4 pt-3.5">
            <View className="flex-1">
              <Text className="text-[26px] font-extrabold text-white tracking-tight">{ticket.fromCode}</Text>
              {ticket.fromCity ? (
                <Text className="text-[11px] text-[#8A8A90] mt-0.5">{ticket.fromCity}</Text>
              ) : null}
            </View>
            <View className="flex-[2] items-center px-2 gap-1">
              <Text className="text-[11px] text-[#8A8A90]">{formatDuration(ticket.durationMinutes)}</Text>
              <View className="w-full h-px bg-[#2E2E30] relative">
                <View className="absolute -top-[3.5px] left-0 w-2 h-2 rounded-full bg-[#2E2E30]" />
                <View
                  className="absolute -top-[3.5px] right-0 w-2 h-2 rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
              </View>
              <Text
                className="text-[10px] font-semibold"
                style={{ color: ticket.stops === 0 ? "#7FEA4D" : "#56565C" }}
              >
                {stopsLabel}
              </Text>
            </View>
            <View className="flex-1 items-end">
              <Text className="text-[26px] font-extrabold text-white tracking-tight">{ticket.toCode}</Text>
              {ticket.toCity ? (
                <Text className="text-[11px] text-[#8A8A90] mt-0.5">{ticket.toCity}</Text>
              ) : null}
            </View>
          </View>

          {ticket.departTime || ticket.arriveTime ? (
            <View className="flex-row justify-between px-4 pt-1 pb-1">
              <Text className="text-[13px] font-semibold text-[#C8C8CC]">{departStr}</Text>
              <Text className="text-[13px] font-semibold text-[#C8C8CC]">{arriveStr}</Text>
            </View>
          ) : null}
        </>
      ) : null}

      <View className="mx-4 my-3 border-t border-dashed border-[#2E2E30]" />

      <RippleTouch
        onPress={() => setZoom(true)}
        className="mx-4 mb-3 rounded-xl overflow-hidden bg-[#1A1A1A]"
      >
        <Image
          source={{ uri: ticket.pageImage }}
          style={{ width: "100%", aspectRatio: 1 / ratio }}
          resizeMode="contain"
        />
      </RippleTouch>

      <View className="flex-row items-center justify-between px-4 pb-4">
        <View className="flex-1 pr-3">
          {ticket.passenger ? (
            <>
              <Text className="text-[11px] font-semibold text-[#56565C] tracking-wider uppercase mb-1">
                {t("saved.ticket.passenger")}
              </Text>
              <Text className="text-sm font-semibold text-white" numberOfLines={1}>
                {ticket.passenger}
              </Text>
            </>
          ) : null}
          {dateStr ? (
            <Text className="text-xs text-[#8A8A90] mt-0.5">{dateStr}</Text>
          ) : null}
          {ticket.seat || ticket.travelClass ? (
            <Text className="text-xs text-[#8A8A90] mt-0.5">
              {[
                ticket.seat ? `${t("saved.ticket.seat")} ${ticket.seat}` : null,
                ticket.travelClass,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          ) : null}
        </View>
        <RippleTouch
          onPress={confirmDelete}
          hitSlop={8}
          className="w-10 h-10 rounded-xl items-center justify-center"
          borderless
          style={{ backgroundColor: "rgba(255,59,48,0.1)" }}
        >
          <Trash2 size={18} color="#FF3B30" />
        </RippleTouch>
      </View>

      <Modal visible={zoom} animationType="fade" transparent onRequestClose={() => setZoom(false)}>
        <View className="flex-1 bg-black">
          <RippleTouch
            onPress={() => setZoom(false)}
            hitSlop={12}
            className="absolute top-14 right-5 z-10 w-10 h-10 rounded-full bg-[#1F1F20] items-center justify-center"
            borderless
          >
            <X size={20} color="#FFFFFF" />
          </RippleTouch>
          <ScrollView
            maximumZoomScale={4}
            minimumZoomScale={1}
            contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}
            showsVerticalScrollIndicator={false}
          >
            <Image
              source={{ uri: ticket.pageImage }}
              style={{ width: "100%", aspectRatio: 1 / ratio }}
              resizeMode="contain"
            />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}
