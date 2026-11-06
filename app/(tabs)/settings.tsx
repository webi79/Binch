import { ReactNode, createContext, memo, useCallback, useContext, useEffect, useRef, useState, useMemo } from "react";
import { subscribeLayer, prepareLayer, holdLayer, rearmLayer } from "@/lib/nav/transitionLayer";
import { markTransitionBusy } from "@/lib/nav/transitionBusy";
import { setSheetMoving } from "@/lib/nav/searchHandoff";
import {
  preloadSettingsSub,
  subscribeSettingsPreload,
  type SettingsCategoryId,
  type SettingsSubId,
} from "@/lib/nav/settingsPreload";
import { OnFocusLost } from "@/lib/nav/FocusSentinel";
import {
  AppState,
  Platform,
  BackHandler,
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  Linking,
  Image,
  ActivityIndicator,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { usePressBounce } from "@/lib/motion";
import { forgetSocialSession } from "@/lib/auth/socialSignIn";
import {
  PUSH_SPRING,
  POP_SPRING,
  SCREEN_CORNER_RADIUS,
  UNDERLAY_TRAVEL_FRAC,
  settingsPush,
} from "@/lib/nav/overlayCover";
import { CLOSE_ICON_SIZE, GUTTER, SPACE, HEADING_TOP, HEADING_GAP, useNavbarSpace, GROUP_GAP, SECTION_GAP, TITLE_GAP } from "@/lib/theme/spacing";
import { ScreenHeading } from "@/components/ui/ScreenHeading";
import * as ImagePicker from "expo-image-picker";
import { requestWithPrimer } from "@/lib/permissions/primer";
import * as ImageManipulator from "expo-image-manipulator";
import Svg, { Defs, Ellipse, G, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import {
  ChevronRight,
  X,
  User,
  Mail,
  Lock,
  Shield,
  MessageSquare,
  ChevronDown,
  LogOut,
  LogIn,
  Pencil,
  Brain,
  Trash2,
  Palette,
  Globe,
  Bell,
  Tag,
  Vibrate,
  BellOff,
  Download,
  Train,
  Users,
  TicketCheck,
  Accessibility,
  Wifi,
  Route,
  Bike,
} from "lucide-react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { ensurePushToken, knownPushToken, reregisterDevice } from "@/lib/notifications/push";
import { showStatusToast } from "@/components/ui/StatusToast";
import { syncPriceAlerts } from "@/lib/notifications/syncAlerts";
import { ARRIVAL_LEADS, REMINDER_LEADS, type ArrivalLead, type ReminderLead } from "@/lib/notifications/tripReminders";
import {
  boMemoryKeyFor,
  chatThreadsKeyFor,
  clearBoMemory,
  deleteBoMemoryEntry,
  fetchBoMemory,
  setBoMemoryEnabled,
  type BoMemoryState,
} from "@/lib/api/chats";
import { useSearchStore, Locale } from "@/stores/searchStore";
import { useAccent, ACCENT_LIST, type AccentId } from "@/lib/theme/accent";
import { useAppBg, usePalette } from "@/lib/theme/appBg";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { authDeleteAccount, authLogout, authUpdateAvatar } from "@/lib/api/client";
import { exportMyData } from "@/lib/account/exportData";
import { RAIL_CARDS, RAIL_CARD_LABEL, TRANSFER_MINUTES, type RailCard, type TransferMinutes } from "@/lib/travel/fareProfile";
import { showAlert } from "@/lib/alert";
import { RippleTouch } from "@/components/ui/RippleTouch";
import {
  ChoiceGrid,
  ChoiceSegment,
  ControlLabel,
  DangerButton,
  Footnote,
  ListCard,
  MiniChat,
  MiniHome,
  MiniResults,
  MiniSearch,
  MiniToast,
  NoticeRow,
  Panel,
  PreviewCard,
  SectionTitle,
  StepperRow,
  PlaceField,
  SwitchLine,
  SwitchRow,
} from "@/components/settings/SettingsBlocks";
import { DeliveryTest } from "@/components/settings/DeliveryTest";
import { scaledStyles } from "@/lib/ui/compact";
import { slideTiming } from "@/lib/nav/slideMotion";
import { GridLoader } from "@/components/ui/GridLoader";
import { LoadGate } from "@/components/ui/LoadGate";
import { StatePanel } from "@/components/ui/StatePanel";

const C = {
  bg: "#0D0D0D",
  s1: "#171719",
  s2: "#171719",
  s3: "#212123",
  border: "#212123",
  green: "#7FEA4D",
  greenDark: "#2BB857",
  greenSubtle: "#1A3D26",
  white: "#F4F4F5",
  g1: "#C8C8CC",
  g2: "#8E8E93",
  g3: "#56565C",
  red: "#FF453A",
};

function makeInitials(firstName: string, lastName: string): string {
  const f = firstName.trim()[0] ?? "";
  const l = lastName.trim()[0] ?? "";
  const out = (f + l).toUpperCase();
  return out || "?";
}

type SubScreen = SettingsSubId | null;

export default function SettingsScreen() {
  const t = useT();
  const appBg = useAppBg();

  // Beim VERLASSEN des Tabs auf den Hub zurücksetzen: Sonst bleibt der zuletzt
  // geöffnete Unterscreen (Details/Einstellungen/Support) stehen und man landet
  // beim nächsten Tab-Wechsel wieder dort statt im Profil-Hub. Beim Verlassen
  // (statt beim Betreten) zurücksetzen, damit man den Wechsel nicht sieht — der
  // Screen blendet zu dem Zeitpunkt ohnehin gerade weg.
  // Über <OnFocusLost/> statt useIsFocused() hier oben: Der Hook an dieser
  // Stelle rendete den GESAMTEN Settings-Screen zweimal pro Tab-Wechsel neu
  // (inkl. der nicht memoisierten Hub-Kacheln samt SVG-Illustrationen) — mitten
  // im Wechsel-Frame. Die Sentinel-Komponente rendert stattdessen nur sich
  // selbst; sie steht unten im JSX.

  const setSettingsSub = useSearchStore((st) => st.setSettingsSub);

  const navTo = (id: Exclude<SubScreen, null>) => {
    haptic("button");
    // NUR den Speicher setzen. Die Bewegung startet die Überlagerung selbst, ein
    // Bild später — siehe dort. Hier gestartet lief sie gegen den Aufbau des
    // Unterschirms an, und der ist ein großer Baum mit eigenen Grafiken.
    setSettingsSub(id);
  };

  const { width: screenW } = useWindowDimensions();
  const navbarSpace = useNavbarSpace();
  /**
   * Der Hub weicht um 30% nach links — derselbe Anteil wie überall sonst.
   *
   * Der Unterschirm selbst liegt NICHT mehr hier, sondern am Wurzel-Layout
   * (siehe SettingsSubOverlay unten). Nur von dort deckt er die native
   * Tab-Leiste mit ab; im Tab-Container endete er über ihr, und seine
   * gerundeten Ecken standen mitten im Bild.
   */
  const hubStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: settingsPush.value * screenW * UNDERLAY_TRAVEL_FRAC }],
  }));

  // Keine gestaffelte Einblend-Welle mehr — siehe Landingscreen.
  return (
    <>
    <OnFocusLost
      run={() => {
        // Ohne Bewegung zurücksetzen — der Tab blendet ohnehin gerade weg.
        setSettingsSub(null);
        settingsPush.value = 0;
      }}
    />
    <SafeAreaView style={[styles.safe, { backgroundColor: appBg }]} edges={["top"]}>
      {/* Die Überschrift liegt MIT im Hub, nicht darüber.
          Sonst bliebe „Profil" stehen, während der Unterschirm darunter
          hereinfährt — und der Hub würde nur zur Hälfte ausweichen. So wandert
          der ganze Tab als ein Körper nach links, und der Unterschirm deckt ihn
          vollständig ab, Überschrift eingeschlossen. */}
      <View style={styles.stack}>
        <HubLayer style={[styles.layer, hubStyle]}>
          <View style={{ paddingHorizontal: GUTTER, paddingTop: HEADING_TOP }}>
            <ScreenHeading>{t("bottomnav.settings")}</ScreenHeading>
          </View>
          <Animated.ScrollView
            // Reanimated setzt auf seinen Scroll-Flächen ungefragt
            // scrollEventThrottle=1, also EIN Ereignis pro Bild — bei 120Hz 120
            // pro Sekunde zum JS-Thread, für eine Fläche ganz ohne onScroll.
            scrollEventThrottle={16}
            contentContainerStyle={{ paddingBottom: navbarSpace }}
            showsVerticalScrollIndicator={false}
          >
            <Hub onNav={navTo} />
          </Animated.ScrollView>
        </HubLayer>

      </View>
    </SafeAreaView>
    </>
  );
}

/**
 * Die wandernde Ebene des Hubs — als eigene Komponente, wegen der Textur.
 *
 * Der Profil-Hub war die EINZIGE Unterlage der App ohne GPU-Textur. Landing,
 * Saved und Ergebnisliste hängen alle am Textur-Modul; hier wurde eine
 * Scroll-Fläche mit Profilkarte und drei Kachel-Illustrationen (zusammen rund 40
 * SVG-Knoten) 30% der Breite weit verschoben und dabei jedes Bild neu
 * gezeichnet — der im Projekt mit 14,7ms vermessene Fall gegen ein Budget von
 * 8,3ms.
 *
 * Eigene Komponente aus demselben Grund wie bei den drei anderen: Läge der
 * Zustand im Bildschirm selbst, rendete dessen kompletter Baum im
 * Berührungs-Frame neu — genau das, was die Textur verhindern soll.
 */
function HubLayer({ style, children }: { style: StyleProp<ViewStyle>; children: ReactNode }) {
  const [layered, setLayered] = useState(false);
  useEffect(() => subscribeLayer("settings", setLayered), []);
  return (
    <Animated.View
      style={style}
      collapsable={false}
      renderToHardwareTextureAndroid={Platform.OS === "android" && layered}
    >
      {children}
    </Animated.View>
  );
}

/* ─────────────────────── HUB ─────────────────────── */
function Hub({ onNav }: { onNav: (id: Exclude<SubScreen, null>) => void }) {
  const accent = useAccent();
  const t = useT();
  const isAuthed = useSearchStore((s) => s.authUser !== null);
  /** Druck-Effekt wie an den Kacheln im Landingscreen. */
  const signOutBounce = usePressBounce();
  /** Und am Anmelden-Knopf, der an derselben Stelle steht, wenn niemand
   *  angemeldet ist — er war vorhin schlicht übersehen. */
  const signInBounce = usePressBounce();
  const token = useSearchStore((s) => s.authToken);
  const clearAuth = useSearchStore((s) => s.clearAuth);
  const openAuth = useSearchStore((s) => s.openAuthOverlay);

  const tiles: { id: Exclude<SubScreen, null>; titleKey: string; descKey: string; illu: ReactNode }[] = [
    { id: "details", titleKey: "settings.tile.details", descKey: "settings.tile.details.desc", illu: <IlluDetails /> },
    { id: "settings", titleKey: "settings.tile.settings", descKey: "settings.tile.settings.desc", illu: <IlluSettings /> },
    { id: "support", titleKey: "settings.tile.support", descKey: "settings.tile.support.desc", illu: <IlluSupport /> },
  ];

  const onSignOut = () => {
    haptic("button");
    showAlert(
      t("settings.signout.confirm.title"),
      t("settings.signout.confirm.body"),
      [
        { text: t("settings.signout.confirm.cancel"), style: "cancel" },
        {
          text: t("settings.signout.confirm.ok"),
          style: "destructive",
          // Kein `haptic` mehr hier — der Dialog gibt für einen löschenden
          // Knopf schon den kräftigen Stoß, sonst kämen zwei übereinander.
          onPress: async () => {
            if (token) {
              try {
                await authLogout(token, knownPushToken());
              } catch {
                /* server unreachable — local sign-out is still fine */
              }
            }
            clearAuth();
            // Auch die Verknüpfung zum Google-Konto lösen — sonst bekommt man
            // beim nächsten Anmelden keine Kontoauswahl mehr. Siehe dort.
            void forgetSocialSession();
          },
        },
      ],
      // Eine Tür mit Pfeil statt des roten Ausrufezeichens: Abmelden ist kein
      // Unglück, sondern ein Abschied.
      "logout",
    );
  };

  return (
    <View>

        <ProfileCard />

      {/* Spacer matching the hidden "Bereiche" label slot in the design */}
      <View style={{ height: 30 }} />

      <View style={{ paddingHorizontal: GUTTER }}>
        {tiles.map((tile, idx) => (
          <View key={tile.id} style={{ marginBottom: idx < tiles.length - 1 ? 8 : 0 }}>
            <SectionCard
              title={t(tile.titleKey)}
              desc={t(tile.descKey)}
              illu={tile.illu}
              onPress={() => onNav(tile.id)}
              preloadId={tile.id}
            />
          </View>
        ))}
      </View>

      <View style={styles.divider} />

      {/* Der Druck-Effekt am Abmelden-Knopf hängt am Aufsetzen, nicht an
          `onPressIn` — RippleTouch hält das um 50ms zurück, und ein Tipp ist
          meist kürzer. */}
      {isAuthed ? (
        <Animated.View
          style={signOutBounce.style}
          onTouchStart={signOutBounce.onPressIn}
          onTouchEnd={signOutBounce.onPressOut}
          onTouchCancel={signOutBounce.onPressOut}
        >
          <RippleTouch
            onPress={onSignOut}
            style={({ pressed }) => [styles.signOut, pressed && { opacity: 0.7 }]}
          >
            <LogOut size={18} color={C.red} strokeWidth={2} />
            <Text style={styles.signOutText}>{t("settings.signout")}</Text>
          </RippleTouch>
        </Animated.View>
      ) : (
        <Animated.View
          style={signInBounce.style}
          onTouchStart={signInBounce.onPressIn}
          onTouchEnd={signInBounce.onPressOut}
          onTouchCancel={signInBounce.onPressOut}
        >
          <RippleTouch
            onPress={() => {
              haptic("button");
              openAuth();
            }}
            style={({ pressed }) => [styles.signIn, pressed && { opacity: 0.7 }]}
          >
            <LogIn size={18} color={accent.solid} strokeWidth={2} />
            <Text style={[styles.signInText, { color: accent.solid }]}>{t("auth.guest.cta")}</Text>
          </RippleTouch>
        </Animated.View>
      )}

      <Text style={styles.versionText}>{t("settings.app.version")}</Text>
    </View>
  );
}

function ProfileCard() {
  const accent = useAccent();
  const palette = usePalette();
  const t = useT();
  const user = useSearchStore((s) => s.authUser);
  const openAuth = useSearchStore((s) => s.openAuthOverlay);
  const savedCount = useSearchStore((s) => s.savedTrips.length);
  const ticketsCount = useSearchStore((s) => s.tickets.length);

  const isAuthed = !!user;
  const initials = isAuthed ? makeInitials(user.firstName, user.lastName) : "?";

  const onAvatarPress = () => {
    if (!isAuthed) {
      haptic("button");
      openAuth();
    }
  };

  return (
    <View style={[styles.profileCard, { backgroundColor: palette.s2 }]}>
      <View style={styles.profileTopRow}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={styles.eyebrow}>{t("settings.account").toUpperCase()}</Text>
          {isAuthed ? (
            <>
              {/**
                * EIN Text, kein fest eingebauter Umbruch.
                *
                * Hier stand ein `{"\n"}` zwischen Vor- und Nachname — ein
                * hartes Zeilenumbruch-Zeichen. Damit standen sie IMMER
                * untereinander, auch wenn beide bequem nebeneinander gepasst
                * hätten. Als ein Text umbricht er nur dann, wenn der Platz
                * wirklich nicht reicht; zwei Zeilen bleiben als Obergrenze
                * erlaubt, damit ein sehr langer Name nicht abgeschnitten wird.
                */}
              <Text style={styles.profileName} numberOfLines={2}>
                {user.firstName} {user.lastName}
              </Text>
              <Text style={styles.profileEmail}>{user.email}</Text>
            </>
          ) : (
            <Text style={styles.profileName}>{t("auth.guest.title")}</Text>
          )}
        </View>
        <Pressable onPress={onAvatarPress} disabled={isAuthed} style={styles.avatarWrap}>
          {isAuthed && user.avatarDataUrl ? (
            <Image source={{ uri: user.avatarDataUrl }} style={styles.avatar} />
          ) : isAuthed ? (
            <View style={[styles.avatar, { backgroundColor: accent.solid, alignItems: "center", justifyContent: "center" }]}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
          ) : (
            <View style={[styles.avatar, { backgroundColor: palette.s3, borderWidth: 1, borderColor: palette.border }]}>
              <User size={26} color={C.g2} strokeWidth={2} />
            </View>
          )}
          <View pointerEvents="none" style={[styles.avatarRing, { borderColor: accent.border }]} />
          {isAuthed ? <View style={[styles.avatarStatusDot, { backgroundColor: accent.solid }]} /> : null}
        </Pressable>
      </View>

      <View style={styles.profileStatsRow}>
        <Stat val={t("settings.stats.premium")} label={t("settings.stats.status")} accent withDivider />
        <Stat val={String(savedCount)} label={t("settings.stats.trips")} withDivider />
        <Stat val={String(ticketsCount)} label={t("settings.stats.saved")} />
      </View>
    </View>
  );
}

function Stat({ val, label, accent: isAccent, withDivider }: { val: string; label: string; accent?: boolean; withDivider?: boolean }) {
  const accentColor = useAccent();
  return (
    <View style={[styles.statCol, withDivider && styles.statColDivider]}>
      <Text style={[styles.statVal, isAccent && { color: accentColor.solid }]}>{val}</Text>
      <Text style={styles.statLbl}>{label}</Text>
    </View>
  );
}

function SectionCard({
  title,
  desc,
  illu,
  onPress,
  preloadId,
}: {
  title: string;
  desc: string;
  illu: ReactNode;
  onPress: () => void;
  /** Welcher Unterschirm hier hängt — für den Vorbau beim Berühren. */
  preloadId?: SettingsSubId;
}) {
  const palette = usePalette();
  return (
    <RippleTouch
      onPress={onPress}
      // Textur des Hubs beim AUFSETZEN anlegen — nicht beim Loslassen. Der
      // Aufbau ist mit 66ms vermessen, die Bewegung startet unmittelbar nach dem
      // Loslassen. Zwischen Aufsetzen und Loslassen liegen 80 bis 150ms.
      onTouchStart={() => {
        prepareLayer("settings");
        // Und den Unterschirm gleich mit aufbauen — siehe preloadSettingsSub.
        if (preloadId) preloadSettingsSub(preloadId);
      }}
      style={({ pressed }) => [
        styles.sectionCard,
        { backgroundColor: palette.s2 },
        pressed && { backgroundColor: palette.s3, transform: [{ scale: 0.982 }] },
      ]}
    >
      <View style={styles.sectionCardIllu} pointerEvents="none">
        {illu}
      </View>
      <View style={styles.sectionCardTextWrap}>
        <Text style={styles.sectionCardTitle}>{title}</Text>
        <Text style={styles.sectionCardDesc}>{desc}</Text>
      </View>
    </RippleTouch>
  );
}

/* ─────────────────────── DETAILS ─────────────────────── */
function DetailsScreen({ onBack }: { onBack: () => void }) {
  const palette = usePalette();
  const accent = useAccent();
  const t = useT();
  const user = useSearchStore((s) => s.authUser);
  const token = useSearchStore((s) => s.authToken);
  const setAuthUser = useSearchStore((s) => s.setAuthUser);
  const clearAuth = useSearchStore((s) => s.clearAuth);
  const openAuth = useSearchStore((s) => s.openAuthOverlay);
  const queryClient = useQueryClient();
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  /** Server-Auskunft + Gerätedaten als eine Datei, dann das Teilen-Menü (lib/account/exportData.ts). */
  const onExport = async () => {
    if (!token || exporting) return;
    haptic("button");
    setExporting(true);
    try {
      await exportMyData(token, t("settings.privacy.export"));
    } catch {
      showAlert(t("settings.privacy.export.error.title"), t("settings.privacy.export.error.body"));
    } finally {
      setExporting(false);
    }
  };

  /**
   * Konto löschen — zwei Rückfragen, denn es ist endgültig. Die erste sagt,
   * was verschwindet und was bleibt; die zweite ist die Entscheidung.
   */
  const onDeleteAccount = () => {
    if (!token || !user) return;
    haptic("button");
    showAlert(t("settings.account.delete.title"), t("settings.account.delete.body"), [
      { text: t("settings.signout.confirm.cancel"), style: "cancel" },
      {
        text: t("settings.account.delete.next"),
        style: "destructive",
        onPress: () =>
          showAlert(
            t("settings.account.delete.confirm.title"),
            t("settings.account.delete.confirm.body"),
            [
              { text: t("settings.signout.confirm.cancel"), style: "cancel" },
              { text: t("settings.account.delete.confirm.ok"), style: "destructive", onPress: () => void deleteAccount() },
            ],
            "delete",
          ),
      },
    ]);
  };

  const deleteAccount = async () => {
    if (!token || !user) return;
    const uid = user.id;
    try {
      await authDeleteAccount(token);
    } catch {
      // Lokal NICHT abmelden: Sonst stünde der Nutzer abgemeldet da, mit einem
      // Konto, das es noch gibt — und hielte es für gelöscht.
      showAlert(t("settings.account.delete.error.title"), t("settings.account.delete.error.body"));
      return;
    }
    queryClient.removeQueries({ queryKey: chatThreadsKeyFor(uid) });
    queryClient.removeQueries({ queryKey: boMemoryKeyFor(uid) });
    clearAuth();
    void forgetSocialSession();
    // Mit dem Konto sind auf dem Server auch dessen Geräte und Alarme weg. Die
    // Alarme auf DIESEM Gerät bleiben (so steht es im Dialog) — also das Gerät
    // anonym neu anmelden und sie gleich wieder hinterlegen.
    void reregisterDevice().then(() => syncPriceAlerts());
    useSearchStore.getState().showStationToast(t("settings.account.deleted.title"), t("settings.account.deleted.body"));
    onBack();
  };

  const fullName = user ? `${user.firstName} ${user.lastName}` : t("auth.guest.name");
  const initials = user ? makeInitials(user.firstName, user.lastName) : "?";

  const onPickPhoto = async () => {
    if (!user || !token || avatarBusy) return;
    haptic("button");
    const perm = await requestWithPrimer(
      "photos",
      ImagePicker.getMediaLibraryPermissionsAsync,
      ImagePicker.requestMediaLibraryPermissionsAsync,
    );
    if (!perm) return;
    if (!perm.granted) {
      showAlert(t("settings.avatar.permission.title"), t("settings.avatar.permission.body"));
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (result.canceled || !result.assets[0]) return;

    try {
      setAvatarBusy(true);
      const compressed = await ImageManipulator.manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 256, height: 256 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      if (!compressed.base64) throw new Error("Image encoding failed");
      const dataUrl = `data:image/jpeg;base64,${compressed.base64}`;
      const updated = await authUpdateAvatar(token, dataUrl);
      setAuthUser(updated);
      haptic("important");
    } catch (e) {
      showAlert(t("settings.avatar.error.title"), (e as Error).message || t("auth.error.generic"));
    } finally {
      setAvatarBusy(false);
    }
  };

  const onRemovePhoto = () => {
    if (!user || !token || avatarBusy) return;
    showAlert(
      t("settings.avatar.remove.title"),
      t("settings.avatar.remove.body"),
      [
        { text: t("settings.signout.confirm.cancel"), style: "cancel" },
        {
          text: t("settings.avatar.remove.ok"),
          style: "destructive",
          onPress: async () => {
            try {
              setAvatarBusy(true);
              const updated = await authUpdateAvatar(token, null);
              setAuthUser(updated);
              haptic("important");
            } catch {
              /* ignore */
            } finally {
              setAvatarBusy(false);
            }
          },
        },
      ],
    );
  };

  return (
    <View>
      <BackHeader title={t("settings.tile.details")} onBack={onBack} />

      <View style={styles.avatarLargeOuter}>
        <Pressable
          onPress={user ? onPickPhoto : () => { haptic("button"); openAuth(); }}
          disabled={avatarBusy}
          style={styles.avatarLargeWrap}
        >
          {user && user.avatarDataUrl ? (
            <Image source={{ uri: user.avatarDataUrl }} style={styles.avatarLarge} />
          ) : user ? (
            <View style={[styles.avatarLarge, { backgroundColor: accent.solid, alignItems: "center", justifyContent: "center" }]}>
              <Text style={styles.avatarLargeText}>{initials}</Text>
            </View>
          ) : (
            <View style={[styles.avatarLarge, { backgroundColor: palette.s3, borderWidth: 1, borderColor: palette.border }]}>
              <User size={36} color={C.g2} strokeWidth={2} />
            </View>
          )}
          {user ? (
            <View style={[styles.avatarEditDot, { backgroundColor: accent.solid }]}>
              {avatarBusy ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <Pencil size={12} color="#000" strokeWidth={2.5} />
              )}
            </View>
          ) : null}
        </Pressable>
        {user ? (
          <View style={{ flexDirection: "row", gap: 16, alignItems: "center" }}>
            <Pressable onPress={onPickPhoto} disabled={avatarBusy} hitSlop={6}>
              <Text style={[styles.editPhotoText, { color: accent.solid }]}>{t("settings.detail.editphoto")}</Text>
            </Pressable>
            {user.avatarDataUrl ? (
              <Pressable onPress={onRemovePhoto} disabled={avatarBusy} hitSlop={6}>
                <Text style={[styles.editPhotoText, { color: C.red }]}>
                  {t("settings.avatar.remove.short")}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <Pressable onPress={() => { haptic("button"); openAuth(); }} hitSlop={6}>
            <Text style={[styles.editPhotoText, { color: accent.solid }]}>{t("auth.guest.cta")}</Text>
          </Pressable>
        )}
      </View>

      <SLabel text={t("settings.personal")} />
      <Group>
        <Row
          icon={<User size={16} color={C.white} strokeWidth={2} />}
          label={t("settings.detail.name")}
          value={fullName}
          onPress={() => haptic("button")}
        />
        <Row
          icon={<Mail size={16} color={C.white} strokeWidth={2} />}
          label={t("settings.detail.email")}
          value={user?.email ?? "—"}
          onPress={() => haptic("button")}
          isLast
        />
      </Group>

      <BelowFold>
      <SLabel text={t("settings.security")} />
      <Group>
        <Row
          icon={<Lock size={16} color={C.white} strokeWidth={2} />}
          label={t("settings.password.change")}
          onPress={() => haptic("button")}
        />
        <Row
          icon={<Shield size={16} color={C.white} strokeWidth={2} />}
          label={t("settings.twofactor")}
          value={t("settings.twofactor.off")}
          onPress={() => haptic("button")}
          isLast
        />
      </Group>

      {user && token ? (
        <>
          <SLabel text={t("settings.privacy")} />
          <Group>
            <Row
              icon={<Download size={16} color={C.white} strokeWidth={2} />}
              label={t("settings.privacy.export")}
              sub={t("settings.privacy.export.desc")}
              onPress={() => void onExport()}
              rightEl={exporting ? <ActivityIndicator size="small" color={C.g2} /> : undefined}
            />
            <Row
              icon={<Trash2 size={16} color={C.red} strokeWidth={2} />}
              label={t("settings.account.delete")}
              danger
              onPress={onDeleteAccount}
              isLast
            />
          </Group>
        </>
      ) : null}
      </BelowFold>

    </View>
  );
}

/* ─────────────────────── SETTINGS SUB ─────────────────────── */
/**
 * Design zur Wahl: Grau (Vorgabe) und Schwarz.
 *
 * „Hell" steht noch im Speicher, ist aber nicht ausgearbeitet:
 * `PALETTES.light` in lib/theme/appBg.ts zeichnet wie Grau. Deshalb wird es
 * nicht angeboten. Wer es noch gespeichert hat, sieht Grau gewählt, denn
 * genau das sieht er auch.
 */
const THEME_CHOICES = ["gray", "dark"] as const;

/** Sprachen in ihrer eigenen Schreibung, wie in jeder Sprachauswahl üblich. */
const LANGS: { id: Locale; label: string }[] = [
  { id: "de", label: "Deutsch" },
  { id: "en", label: "English" },
  { id: "fr", label: "Français" },
  { id: "es", label: "Español" },
];

/** Als Kürzel, genau so, wie die Ergebniskarten die Währung hinter den Preis schreiben. */
const CURRENCIES = ["EUR", "USD", "GBP", "JPY", "CHF", "SEK"].map((c) => ({ id: c, label: c }));

/*
 * DIE EINSTELLUNGEN — zwei Ebenen.
 *
 * Bis zum 28.10.2026 stand alles auf EINER Seite „Einstellungen" (Design, Farbe,
 * Sprache, Währung, Schalter, Bo, Hinweis-Lage) — mehrere Bildschirme hoch und
 * nach Aussage des Nutzers „zu voll". Jetzt zeigt die Einstellungs-Slide nur
 * eine Auswahl der Kategorien (`SettingsMenuScreen`, schlichte Liste ohne
 * Bo-Bilder — so gewünscht), und jede fährt als ZWEITE Slide darüber herein
 * (siehe `SettingsSubOverlay`). Jede Kategorie-Seite beginnt mit einer
 * Vorschau-Karte (`components/settings/SettingsBlocks.tsx`).
 */

/** Reihenfolge und Symbole der Auswahl; Titel und Zeile darunter aus `settings.tile.<id>`. */
const SETTINGS_CATEGORIES: { id: SettingsCategoryId; Icon: typeof Palette }[] = [
  // Reisen zuerst — das ist, wofür man die App hat.
  { id: "travel", Icon: Train },
  { id: "appearance", Icon: Palette },
  { id: "language", Icon: Globe },
  { id: "notifications", Icon: Bell },
  { id: "bo", Icon: Brain },
];

/* ─────────────────────── EINSTELLUNGEN (Auswahl) ─────────────────────── */
function SettingsMenuScreen({
  onBack,
  onOpen,
  onPreload,
}: {
  onBack: () => void;
  onOpen: (id: SettingsCategoryId) => void;
  onPreload: (id: SettingsCategoryId) => void;
}) {
  const t = useT();
  const palette = usePalette();
  return (
    <View>
      <BackHeader title={t("settings.title")} onBack={onBack} />
      <View style={{ height: 8 }} />
      <Group>
        {SETTINGS_CATEGORIES.map(({ id, Icon }, i) => (
          <Row
            key={id}
            icon={<Icon size={16} color={C.white} strokeWidth={2} />}
            iconBg={palette.s3}
            label={t(`settings.tile.${id}`)}
            sub={t(`settings.tile.${id}.desc`)}
            onTouchStart={() => onPreload(id)}
            onPress={() => onOpen(id)}
            isLast={i === SETTINGS_CATEGORIES.length - 1}
          />
        ))}
      </Group>
    </View>
  );
}

/* ─────────────────────── REISEN ─────────────────────── */
/** Die Karten in der Reihenfolge der Auswahl; „keine" zuerst. */
const CARD_CHOICES: (RailCard | "none")[] = ["none", ...RAIL_CARDS];

/**
 * Womit eine neue Suche beginnt (Zuhause, Reisende, Klasse) und womit die Bahn
 * rechnet (Ermäßigungskarte, Deutschlandticket). Siehe lib/travel/fareProfile.ts.
 */
function TravelScreen({ onBack }: { onBack: () => void }) {
  const t = useT();
  const trainClass = useSearchStore((s) => s.defaultTrainClass);
  const setTrainClass = useSearchStore((s) => s.setDefaultTrainClass);
  const pax = useSearchStore((s) => s.defaultPassengers);
  const setPax = useSearchStore((s) => s.setDefaultPassengers);
  const card = useSearchStore((s) => s.railCard);
  const setCard = useSearchStore((s) => s.setRailCard);
  const dTicket = useSearchStore((s) => s.dTicket);
  const setDTicket = useSearchStore((s) => s.setDTicket);
  const dTicketOnly = useSearchStore((s) => s.dTicketOnly);
  const setDTicketOnly = useSearchStore((s) => s.setDTicketOnly);
  const transfer = useSearchStore((s) => s.transferMinutes);
  const setTransfer = useSearchStore((s) => s.setTransferMinutes);
  const bike = useSearchStore((s) => s.bikeCarriage);
  const setBike = useSearchStore((s) => s.setBikeCarriage);

  return (
    <View>
      <BackHeader title={t("settings.tile.travel")} onBack={onBack} />
      <View style={styles.pageTop} />
      <PreviewCard phone={<MiniSearch />} title={t("settings.travel.preview")} desc={t("settings.travel.preview.desc")}>
        <ChoiceSegment
          items={[
            { id: "search.class.second", label: t("search.class.second") },
            { id: "search.class.first", label: t("search.class.first") },
          ]}
          value={trainClass}
          onChange={setTrainClass}
        />
      </PreviewCard>

      <SectionTitle text={t("settings.travel.places")} />
      <PlaceField
        which="home"
        emptyLabel={t("settings.travel.home.none")}
        hint={t("settings.travel.home.desc")}
        placeholder={t("settings.travel.home.search")}
        changeLabel={t("settings.travel.home.change")}
        removeLabel={t("settings.travel.home.remove")}
        cancelLabel={t("settings.signout.confirm.cancel")}
      />
      <View style={styles.cardGap} />
      <PlaceField
        which="work"
        emptyLabel={t("settings.travel.work.none")}
        hint={t("settings.travel.work.desc")}
        placeholder={t("settings.travel.home.search")}
        changeLabel={t("settings.travel.home.change")}
        removeLabel={t("settings.travel.work.remove")}
        cancelLabel={t("settings.signout.confirm.cancel")}
      />

      <SectionTitle text={t("search.pax.title")} />
      <ListCard>
        <StepperRow
          Icon={Users}
          label={t("search.pax.adults")}
          desc={t("settings.travel.pax.desc")}
          value={pax}
          min={1}
          max={9}
          onChange={setPax}
          lessLabel={t("settings.travel.pax.less")}
          moreLabel={t("settings.travel.pax.more")}
        />
      </ListCard>

      <SectionTitle text={t("settings.travel.card")} />
      <Panel>
        <ChoiceGrid
          columns={2}
          items={CARD_CHOICES.map((id) => ({
            id,
            label: id === "none" ? t("settings.travel.card.none") : RAIL_CARD_LABEL[id].name,
          }))}
          value={card ?? "none"}
          onChange={(id) => setCard(id === "none" ? null : id)}
        />
      </Panel>
      <View style={styles.cardGap} />
      <ListCard>
        <SwitchRow
          Icon={TicketCheck}
          label="Deutschlandticket"
          desc={t("settings.travel.dticket.desc")}
          value={dTicket}
          onChange={(v) => {
            haptic("button");
            setDTicket(v);
          }}
        />
        <SwitchRow
          Icon={Route}
          label={t("settings.travel.dticketonly.label")}
          desc={t("settings.travel.dticketonly.desc")}
          value={dTicket && dTicketOnly}
          disabled={!dTicket}
          onChange={(v) => {
            haptic("button");
            setDTicketOnly(v);
          }}
          isLast
        />
      </ListCard>
      <Footnote text={t("settings.travel.card.note")} />

      <SectionTitle text={t("settings.travel.transfer.section")} />
      <Panel title={t("settings.travel.transfer.label")} desc={t("settings.travel.transfer.desc")}>
        <ChoiceSegment
          items={TRANSFER_MINUTES.map((m) => ({
            id: String(m),
            label: m === 0 ? t("settings.travel.transfer.normal") : t("settings.reminder.min").replace("{n}", String(m)),
          }))}
          value={String(transfer)}
          onChange={(id) => setTransfer(Number(id) as TransferMinutes)}
        />
      </Panel>
      <View style={styles.cardGap} />
      <ListCard>
        <SwitchRow
          Icon={Bike}
          label={t("settings.travel.bike.label")}
          desc={t("settings.travel.bike.desc")}
          value={bike}
          onChange={(v) => {
            haptic("button");
            setBike(v);
          }}
          isLast
        />
      </ListCard>
    </View>
  );
}

/* ─────────────────────── DARSTELLUNG ─────────────────────── */
function AppearanceScreen({ onBack }: { onBack: () => void }) {
  const t = useT();
  const theme = useSearchStore((s) => s.theme);
  const setTheme = useSearchStore((s) => s.setTheme);
  const accentId = useSearchStore((s) => s.accent);
  const setAccent = useSearchStore((s) => s.setAccent);
  const reduceMotion = useSearchStore((s) => s.reduceMotion);
  const setReduceMotion = useSearchStore((s) => s.setReduceMotion);
  const dataSaver = useSearchStore((s) => s.dataSaver);
  const setDataSaver = useSearchStore((s) => s.setDataSaver);

  return (
    <View>
      <BackHeader title={t("settings.tile.appearance")} onBack={onBack} />
      <View style={styles.pageTop} />
      <PreviewCard phone={<MiniHome />} title={t("settings.theme")} desc={t("settings.theme.pitch")}>
        <ChoiceSegment
          items={THEME_CHOICES.map((id) => ({ id, label: t(`theme.label.${id}`) }))}
          value={theme === "dark" ? "dark" : "gray"}
          onChange={setTheme}
          commitAfterSlide
        />
        <ControlLabel text={t("settings.accent")} />
        <ChoiceSegment
          items={ACCENT_LIST.map((a) => ({ id: a.id, label: t(`color.label.${a.id}`), dot: a.solid }))}
          value={accentId}
          onChange={setAccent}
          commitAfterSlide
        />
      </PreviewCard>
      <Footnote text={t("settings.accent.note")} />

      <SectionTitle text={t("settings.motion.section")} />
      <ListCard>
        <SwitchRow
          Icon={Accessibility}
          label={t("settings.motion.label")}
          desc={t("settings.motion.desc")}
          value={reduceMotion}
          onChange={(v) => {
            haptic("button");
            setReduceMotion(v);
          }}
        />
        <SwitchRow
          Icon={Wifi}
          label={t("settings.datasaver.label")}
          desc={t("settings.datasaver.desc")}
          value={dataSaver}
          onChange={(v) => {
            haptic("button");
            setDataSaver(v);
          }}
          isLast
        />
      </ListCard>
    </View>
  );
}

/* ─────────────────────── SPRACHE & WÄHRUNG ─────────────────────── */
function LanguageScreen({ onBack }: { onBack: () => void }) {
  const t = useT();
  const locale = useSearchStore((s) => s.locale);
  const setLocale = useSearchStore((s) => s.setLocale);
  const currency = useSearchStore((s) => s.currency);
  const setCurrency = useSearchStore((s) => s.setCurrency);

  return (
    <View>
      <BackHeader title={t("settings.tile.language")} onBack={onBack} />
      <View style={styles.pageTop} />
      <PreviewCard phone={<MiniHome />} title={t("settings.language")} desc={t("settings.language.pitch")}>
        <ChoiceGrid columns={2} items={LANGS} value={locale} onChange={setLocale} />
      </PreviewCard>
      <View style={styles.cardGap} />
      <PreviewCard phone={<MiniResults />} title={t("settings.currency")} desc={t("settings.currency.pitch")}>
        <ChoiceGrid columns={3} items={CURRENCIES} value={currency} onChange={setCurrency} />
      </PreviewCard>
      <Footnote text={t("settings.currency.note")} />
    </View>
  );
}

/* ─────────────────────── MITTEILUNGEN ─────────────────────── */
/**
 * Hat jemand Mitteilungen für Binch am HANDY abgeschaltet?
 *
 * Dann nützen die Schalter hier nichts, und das soll die Seite sagen, statt
 * Wirkung vorzutäuschen. Gelesen beim Öffnen und jedes Mal, wenn die App wieder
 * in den Vordergrund kommt — meist aus genau den Systemeinstellungen, in die
 * der Hinweis führt. „Noch nie gefragt" zählt nicht als abgeschaltet: Dann
 * fragt das Einschalten selbst.
 */
function useSystemNotificationsBlocked(): [boolean, () => void] {
  const [blocked, setBlocked] = useState(false);
  const aliveRef = useRef(true);
  const check = useCallback(() => {
    Notifications.getPermissionsAsync()
      .then((p) => {
        if (aliveRef.current) setBlocked(p.status === "denied");
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    aliveRef.current = true;
    check();
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") check();
    });
    return () => {
      aliveRef.current = false;
      sub.remove();
    };
  }, [check]);
  return [blocked, check];
}

function NotificationsScreen({ onBack }: { onBack: () => void }) {
  const t = useT();
  const [systemBlocked, recheckSystem] = useSystemNotificationsBlocked();
  const hapticsEnabled = useSearchStore((s) => s.hapticsEnabled);
  const setHapticsEnabled = useSearchStore((s) => s.setHapticsEnabled);
  const notificationsEnabled = useSearchStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useSearchStore((s) => s.setNotificationsEnabled);
  const priceAlertsEnabled = useSearchStore((s) => s.priceAlertsEnabled);
  const setPriceAlertsEnabled = useSearchStore((s) => s.setPriceAlertsEnabled);
  const boUpdatesEnabled = useSearchStore((s) => s.boUpdatesEnabled);
  const setBoUpdatesEnabled = useSearchStore((s) => s.setBoUpdatesEnabled);
  const savedToastPosition = useSearchStore((s) => s.savedToastPosition);
  const setSavedToastPosition = useSearchStore((s) => s.setSavedToastPosition);
  const reminder = useSearchStore((s) => s.tripReminderMinutes);
  const setReminder = useSearchStore((s) => s.setTripReminderMinutes);
  const arrival = useSearchStore((s) => s.arrivalReminderMinutes);
  const setArrival = useSearchStore((s) => s.setArrivalReminderMinutes);
  /** Wer eine Erinnerung will, wird JETZT nach der Erlaubnis gefragt — nicht erst, wenn sie fällig wäre und still bliebe. */
  const askIfNeeded = () => {
    void requestWithPrimer("notifications", Notifications.getPermissionsAsync, Notifications.requestPermissionsAsync)
      .catch(() => null)
      .finally(recheckSystem);
  };
  const minutesLabel = (m: number) =>
    m === 0 ? t("settings.reminder.off") : m === 60 ? t("settings.reminder.hour") : t("settings.reminder.min").replace("{n}", String(m));

  return (
    <View>
      <BackHeader title={t("settings.tile.notifications")} onBack={onBack} />
      <View style={styles.pageTop} />
      <PreviewCard
        phone={<MiniToast position={savedToastPosition} />}
        title={t("settings.toast.title")}
        desc={t("settings.toast.pitch")}
      >
        <ChoiceSegment
          items={[
            { id: "top", label: t("settings.toast.top") },
            { id: "bottom", label: t("settings.toast.bottom") },
          ]}
          value={savedToastPosition}
          onChange={setSavedToastPosition}
        />
      </PreviewCard>

      <SectionTitle text={t("settings.notifs.section")} />
      {notificationsEnabled && systemBlocked ? (
        <NoticeRow
          Icon={BellOff}
          title={t("settings.notifs.systemOff")}
          action={t("settings.notifs.openSystem")}
          onPress={() => void Linking.openSettings()}
        />
      ) : null}
      <ListCard>
        <SwitchRow
          Icon={Bell}
          label={t("settings.notifs.label")}
          desc={t("settings.notifs.desc")}
          value={notificationsEnabled}
          onChange={(v) => {
            haptic("button");
            setNotificationsEnabled(v);
            // Einschalten ist der Anlass, nach der Erlaubnis zu fragen (falls
            // noch nie gefragt) — und die Anmeldung trägt den neuen Stand mit.
            // Bestätigt wird erst, wenn es wirklich geht.
            if (v) {
              void ensurePushToken()
                .then((r) => {
                  if (r.ok) showStatusToast("notifyOn");
                })
                .finally(recheckSystem);
            } else showStatusToast("notifyOff");
          }}
        />
        <SwitchRow
          Icon={Tag}
          label={t("settings.pricealerts.label")}
          desc={t("settings.pricealerts.desc")}
          value={priceAlertsEnabled}
          disabled={!notificationsEnabled}
          onChange={(v) => {
            haptic("button");
            setPriceAlertsEnabled(v);
          }}
        />
        <SwitchRow
          Icon={Brain}
          label={t("settings.boUpdates.label")}
          desc={t("settings.boUpdates.desc")}
          value={boUpdatesEnabled}
          disabled={!notificationsEnabled}
          onChange={(v) => {
            haptic("button");
            setBoUpdatesEnabled(v);
          }}
        />
        <SwitchRow
          Icon={Vibrate}
          label={t("settings.haptics.label")}
          desc={t("settings.haptics.desc")}
          value={hapticsEnabled}
          onChange={(v) => {
            setHapticsEnabled(v);
            if (v) haptic("button");
          }}
          isLast
        />
      </ListCard>

      <SectionTitle text={t("settings.reminder.section")} />
      <Panel title={t("settings.reminder.label")} desc={t("settings.reminder.desc")} disabled={!notificationsEnabled}>
        <ChoiceSegment
          items={REMINDER_LEADS.map((m) => ({ id: String(m), label: minutesLabel(m) }))}
          value={String(reminder)}
          onChange={(id) => {
            const m = Number(id) as ReminderLead;
            setReminder(m);
            if (m > 0) askIfNeeded();
          }}
        />
      </Panel>
      <View style={styles.cardGap} />
      <Panel title={t("settings.reminder.arrival.label")} desc={t("settings.reminder.arrival.desc")} disabled={!notificationsEnabled}>
        <ChoiceSegment
          items={ARRIVAL_LEADS.map((m) => ({ id: String(m), label: minutesLabel(m) }))}
          value={String(arrival)}
          onChange={(id) => {
            const m = Number(id) as ArrivalLead;
            setArrival(m);
            if (m > 0) askIfNeeded();
          }}
        />
      </Panel>
      <Footnote text={t("settings.reminder.note")} />

      <DeliveryTest disabled={!notificationsEnabled} />
    </View>
  );
}

/* ─────────────────────── BO ─────────────────────── */
function BoScreen({ onBack }: { onBack: () => void }) {
  const t = useT();
  return (
    <View>
      <BackHeader title={t("settings.tile.bo")} onBack={onBack} />
      <View style={styles.pageTop} />
      <BoMemorySection />
    </View>
  );
}

/* ─────────────────────── SUPPORT ─────────────────────── */
/**
 * Herkunft der Fahrplan- und Haltestellen-Daten — die Lizenzen verlangen eine Nennung „an
 * geeigneter Stelle". Für Österreich steht der Wortlaut im Lizenztext fest (Mobilitätsverbünde
 * Österreich OG, Abschnitt 3a), für Wien ebenso (Stadt Wien) — deshalb unübersetzt. Hinweis auf
 * die Bearbeitung und Haftungsausschluss darunter (`settings.sources.note`).
 */
const SOURCES = [
  { label: "settings.sources.at", attribution: "Datenquelle: Mobilitätsverbünde Österreich OG – data.mobilitaetsverbuende.at", url: "https://data.mobilitaetsverbuende.at" },
  { label: "settings.sources.vienna", attribution: "Datenquelle: Stadt Wien – data.wien.gv.at", url: "https://data.wien.gv.at" },
  { label: "settings.sources.de", attribution: "gtfs.de – DELFI e.V.", url: "https://gtfs.de" },
  { label: "settings.sources.osm", attribution: "© OpenStreetMap-Mitwirkende (ODbL)", url: "https://www.openstreetmap.org/copyright" },
  { label: "settings.sources.transitous", attribution: "Transitous – transitous.org", url: "https://transitous.org" },
  {
    label: "settings.sources.more",
    attribution: "opentransportdata.swiss · OVapi · Bus Open Data Service/NaPTAN (OGL v3.0) · Île-de-France Mobilités · PID · ZTM Warszawa · SNCB",
    url: null,
  },
] as const;

function SupportSubScreen({ onBack }: { onBack: () => void }) {
  const palette = usePalette();
  const t = useT();
  const [open, setOpen] = useState<number | null>(null);

  const faqs: { q: string; a: string }[] = [
    { q: t("settings.faq.q1"), a: t("settings.faq.a1") },
    { q: t("settings.faq.q2"), a: t("settings.faq.a2") },
    { q: t("settings.faq.q3"), a: t("settings.faq.a3") },
  ];

  return (
    <View>
      <BackHeader title={t("settings.tile.support")} onBack={onBack} />

      <SLabel text={t("settings.support.contact")} />
      <Group>
        <Row
          icon={<MessageSquare size={16} color={C.white} strokeWidth={2} />}
          iconBg="#1A3352"
          label={t("settings.support.chat")}
          sub={t("settings.support.chat.sub")}
          onPress={() => haptic("button")}
        />
        <Row
          icon={<Mail size={16} color={C.white} strokeWidth={2} />}
          label={t("settings.support.email.label")}
          sub={t("settings.support.email.sub")}
          onPress={() => {
            haptic("button");
            Linking.openURL("mailto:support@binch.app");
          }}
          isLast
        />
      </Group>

      <BelowFold>
      <SLabel text={t("settings.support.faq")} />
      <View style={[styles.group, { backgroundColor: palette.s2 }]}>
        {faqs.map((f, i) => {
          const isOpen = open === i;
          const isLast = i === faqs.length - 1;
          return (
            <View key={i} style={!isLast && styles.rowDivider}>
              <RippleTouch
                onPress={() => {
                  haptic("button");
                  setOpen(isOpen ? null : i);
                }}
                style={styles.faqRow}
              >
                <Text style={styles.faqQ}>{f.q}</Text>
                <View
                  style={{ transform: [{ rotate: isOpen ? "180deg" : "0deg" }] }}
                >
                  <ChevronDown size={16} color={C.g2} strokeWidth={2} />
                </View>
              </RippleTouch>
              {isOpen && <Text style={styles.faqA}>{f.a}</Text>}
            </View>
          );
        })}
      </View>

      <SLabel text={t("settings.sources")} />
      <Group>
        {SOURCES.map((s, i) => (
          <Row
            key={s.label}
            label={t(s.label)}
            sub={s.attribution}
            onPress={
              s.url
                ? () => {
                    haptic("button");
                    Linking.openURL(s.url);
                  }
                : undefined
            }
            isLast={i === SOURCES.length - 1}
          />
        ))}
      </Group>
      <Text style={styles.sourcesNote}>{t("settings.sources.note")}</Text>
      </BelowFold>
    </View>
  );
}

/* ─────────────────────── SHARED ─────────────────────── */
/**
 * Kopf eines Unterschirms.
 *
 * Der Titel steht an derselben Stelle und in derselben Schrift wie „Profil" im
 * Hub — über `ScreenHeading`, also dieselbe Komponente, die auch die
 * Überschriften der anderen Tabs setzt. Vorher stand hier eine eigene, deutlich
 * kleinere Zeile (17/600), und darüber blieb zusätzlich „Profil" stehen: zwei
 * Überschriften übereinander, von denen keine zum Rest der App passte.
 */
function BackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.backHeader}>
      <ScreenHeading>{title}</ScreenHeading>
      {/**
       * `Pressable` statt `RippleTouch` — genau wie Bos X und das
       * Ticket-Blatt.
       *
       * Die Material-Welle ist eine Animation auf einer Ansicht INNERHALB des
       * Blattes — und über dem Blatt liegt während der Ausfahrt eine
       * GPU-Textur. Eine Textur ist eine gerasterte Momentaufnahme: Was sich
       * darunter bewegt, macht sie in jedem Bild ungültig, und dann wird die
       * bildschirmfüllende Fläche jedes Bild neu gezeichnet UND neu
       * hochgeladen (im Projekt mit 14,7ms gegen ein Budget von 8,3ms
       * vermessen). Die Welle läuft beim Loslassen aus — also genau in die
       * ersten Bilder der Kurve hinein.
       *
       * Verloren geht dabei nichts: Der Knopf verschwindet im selben Moment
       * mit dem Blatt aus dem Bild, seine Welle sieht ohnehin niemand zu Ende.
       * Die beiden meistbenutzten Schließ-Knöpfe der App machen es seit jeher
       * so.
       */
        }
      <Pressable
        onPress={onBack}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={styles.backHeaderBtn}
      >
        <X size={CLOSE_ICON_SIZE} color="#E5E7EB" strokeWidth={2} />
      </Pressable>
    </View>
  );
}

/**
 * BOS GEDÄCHTNIS — an/aus, die Einträge einzeln löschen, alles vergessen.
 *
 * Kontogebunden: Ohne Anmeldung steht in der Karte nur der Hinweis, und die
 * Liste fehlt. Die Liste kommt vom Server (`/api/chat/memory`) und wird erst
 * geladen, wenn dieser Bereich gerendert wird. Änderungen schreiben den
 * Zwischenspeicher fort statt neu zu laden — was gelöscht wurde, weiß diese
 * Stelle ja schon.
 */
function BoMemorySection() {
  const t = useT();
  const palette = usePalette();
  const queryClient = useQueryClient();
  const token = useSearchStore((s) => s.authToken);
  const userId = useSearchStore((s) => s.authUser?.id ?? null);
  const key = boMemoryKeyFor(userId);
  const query = useQuery({
    queryKey: key,
    queryFn: fetchBoMemory,
    enabled: !!token,
    staleTime: 30_000,
    retry: 1,
  });
  const write = (fn: (prev: BoMemoryState) => BoMemoryState) =>
    queryClient.setQueryData<BoMemoryState>(key, (prev) => (prev ? fn(prev) : prev));
  /** Fehlgeschlagen → den echten Stand vom Server holen statt einen falschen stehen zu lassen. */
  const resync = () => void queryClient.invalidateQueries({ queryKey: key });

  const data = query.data;
  const enabled = data?.enabled ?? true;
  const items = data?.items ?? [];

  return (
    <>
      <PreviewCard phone={<MiniChat />} title={t("settings.bo.memory.label")} desc={t("settings.bo.memory.pitch")}>
        {token ? (
          <SwitchLine
            label={t("settings.bo.memory.allow")}
            value={enabled}
            onChange={(v) => {
              haptic("button");
              write((prev) => ({ ...prev, enabled: v }));
              setBoMemoryEnabled(v).catch(resync);
            }}
          />
        ) : (
          <Text style={styles.cardHint}>{t("settings.bo.memory.login")}</Text>
        )}
      </PreviewCard>

      {token ? (
        <>
          <SectionTitle text={t("settings.bo.memory.list")} />
          <ListCard>
            {/* Lader nach der einen Regel (`LoadGate`): erst nach 2 s, dann mindestens zwei Durchläufe. */}
            <LoadGate
              loading={query.isLoading}
              style={styles.boMemLoading}
              loader={<GridLoader size={44} />}
            >
            {() => query.isError ? (
              // Wie jeder Fehler der App: Zeichnung, Satz, EIN Pillen-Knopf.
              <StatePanel
                compact
                art="offline"
                surface={palette.s2}
                body={t("settings.bo.memory.error")}
                action={t("state.retry")}
                busy={query.isFetching}
                onAction={() => {
                  haptic("button");
                  void query.refetch();
                }}
              />
            ) : items.length === 0 ? (
              <View style={styles.boMemState}>
                <Text style={styles.boMemEmpty}>{t("settings.bo.memory.empty")}</Text>
              </View>
            ) : (
              items.map((item, i) => (
                <View key={item.id} style={styles.boMemItem}>
                  <View
                    style={[
                      styles.boMemBody,
                      i < items.length - 1 && { borderBottomWidth: 1, borderBottomColor: palette.border },
                    ]}
                  >
                    <Text style={styles.boMemText}>{item.content}</Text>
                    <RippleTouch
                      style={styles.boMemDelete}
                      accessibilityRole="button"
                      accessibilityLabel={`${t("settings.bo.memory.delete")}: ${item.content}`}
                      onPress={() => {
                        haptic("button");
                        write((prev) => ({ ...prev, items: prev.items.filter((x) => x.id !== item.id) }));
                        deleteBoMemoryEntry(item.id).catch(resync);
                      }}
                    >
                      <Trash2 size={16} color={C.g2} strokeWidth={2} />
                    </RippleTouch>
                  </View>
                </View>
              ))
            )}
            </LoadGate>
          </ListCard>
          <Footnote text={t("settings.bo.memory.privacy")} />
          {items.length > 0 ? (
            <DangerButton
              label={t("settings.bo.memory.clear")}
              Icon={Trash2}
              onPress={() => {
                haptic("button");
                showAlert(t("settings.bo.memory.clear.title"), t("settings.bo.memory.clear.body"), [
                  { text: t("settings.signout.confirm.cancel"), style: "cancel" },
                  {
                    text: t("settings.bo.memory.clear.ok"),
                    style: "destructive",
                    onPress: () => {
                      write((prev) => ({ ...prev, items: [] }));
                      clearBoMemory().catch(resync);
                    },
                  },
                ]);
              }}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function SLabel({ text }: { text: string }) {
  return <Text style={styles.sLabel}>{text.toUpperCase()}</Text>;
}

function Group({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return <View style={[styles.group, { backgroundColor: palette.s2 }]}>{children}</View>;
}

interface RowProps {
  icon?: ReactNode;
  iconBg?: string;
  label: string;
  value?: string;
  sub?: string;
  onPress?: () => void;
  /** Beim Aufsetzen des Fingers — zum Vorbauen der Seite dahinter. */
  onTouchStart?: () => void;
  isLast?: boolean;
  danger?: boolean;
  rightEl?: ReactNode;
}

function Row({ icon, iconBg, label, value, sub, onPress, onTouchStart, isLast, danger, rightEl }: RowProps) {
  return (
    <RippleTouch
      onPress={onPress}
      onTouchStart={onTouchStart}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.row,
        !isLast && styles.rowDivider,
        pressed && onPress ? { backgroundColor: C.s3 } : null,
      ]}
    >
      {icon ? (
        <View style={[styles.rowIcon, { backgroundColor: iconBg ?? C.s2 }]}>{icon}</View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, danger && { color: C.red }]}>{label}</Text>
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      </View>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      {rightEl !== undefined
        ? rightEl
        : onPress
        ? <ChevronRight size={16} color={C.g3} strokeWidth={2} />
        : null}
    </RippleTouch>
  );
}

/* ─── Hub-Illustrationen: Bo in drei Rollen ─── */
/**
 * Die Kacheln zeigen Bo, unseren Reise-Geist — jeweils in der Rolle seines
 * Bereichs: mit seinem Ausweis (Daten), am Zahnrad drehend (Einstellungen), mit
 * Headset (Support). Vorher standen hier Strichmännchen, die zu keiner anderen
 * Figur der App passten.
 *
 * Figur und Gesicht sind Bos eigene Pfaddaten aus `components/assistant/Bo.tsx`,
 * nur verkleinert und nicht nachgezeichnet: Er soll als DERSELBE erkennbar sein.
 * Bo steht in allen drei Bildern gleich groß an derselben Stelle (`HUB_BO_AT`);
 * nur Requisite und Miene wechseln.
 *
 * Kosten: statisch, ohne Animation und Filter, nur Bos eigener Verlauf.
 * Gleichfarbige Flächen liegen je in EINEM Pfad, denn unter Fabric ist jeder
 * SVG-Knoten eine eigene native Ansicht. Zusammen sind es 51 Knoten, die alten
 * Figuren hatten 55. Alles steht auf Modulebene: Innerhalb einer Komponente
 * definiert, entstünde pro Render ein neuer Komponententyp, und React baute den
 * Baum jedes Mal neu auf.
 */
const BO_INK = "#0D0D0D";
const BO_GLINT = "#F4F4F5";
/** Körper: Kuppe mit Radius 72 um (100|120), vier Zipfel am Saum. */
const BO_BODY =
  "M28 120 A72 72 0 0 1 172 120 L172 197 Q154 221 136 197 Q118 221 100 197 Q82 221 64 197 Q46 221 28 197 Z";
/** Augen: Ellipsen 16 × 21 um (76|120) und (124|120). */
const BO_EYE_L = "M60 120a16 21 0 1 0 32 0a16 21 0 1 0 -32 0Z";
const BO_EYES = BO_EYE_L + "M108 120a16 21 0 1 0 32 0a16 21 0 1 0 -32 0Z";
/**
 * Glanzpunkte, je Auge oben groß und unten klein. Der kleine hat in Bo.tsx 70%
 * Deckkraft; bei 0,7 dp Halbmesser sieht man davon nichts, im selben Pfad spart
 * er aber einen Knoten.
 */
const BO_GLINT_L = "M76.5 112a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0ZM68.4 126a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0Z";
const BO_GLINTS =
  BO_GLINT_L + "M124.5 112a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0ZM116.4 126a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0Z";
const BO_CHEEKS = "M43 150a13 7.5 0 1 0 26 0a13 7.5 0 1 0 -26 0ZM131 150a13 7.5 0 1 0 26 0a13 7.5 0 1 0 -26 0Z";
/** Das zwinkernde Auge ist Bos Freude-Bogen, der Mund das Lächeln vom Winken. */
const BO_WINK = "M109 124 Q124 104 139 124";
const BO_SMILE = "M85 149 Q100 164 115 149";
/** Schief, mit dem rechten Mundwinkel oben: das einzige Neue an Bos Gesicht. */
const BO_SMIRK = "M88 151 Q103 160 114 146";
/** Offener Freude-Mund, gefüllt. */
const BO_LAUGH = "M82 149 Q100 180 118 149 Z";
/** Bos Winke-Arm, hinter dem Körper angesetzt; gedreht wird er um die Schulter (150|132). */
const BO_ARM = "M150 132 C176 126 198 110 205 80";
/** Rund 40 × 45 dp, links in der Fläche; rechts bleibt Platz für die Requisite. */
const HUB_BO_AT = "translate(2 5.5) scale(0.28)";

/**
 * Schloss an der Ausweis-Ecke: Bügel und Körper im Uhrzeigersinn, das
 * Schlüsselloch gegenläufig, also ausgespart. Es sitzt knapp über der Kante des
 * Ausweises — läge die Kante darunter, liefe sie sichtbar durchs Loch.
 */
const HUB_LOCK =
  "M71.5 26H76.5A1.5 1.5 0 0 1 78 27.5V30.5A1.5 1.5 0 0 1 76.5 32H71.5A1.5 1.5 0 0 1 70 30.5V27.5A1.5 1.5 0 0 1 71.5 26Z" +
  "M71.2 27V25.8A2.8 2.8 0 0 1 76.8 25.8V27H75.5V25.8A1.5 1.5 0 0 0 72.5 25.8V27Z" +
  "M75.1 28.9A1.1 1.1 0 1 0 72.9 28.9A1.1 1.1 0 1 0 75.1 28.9Z";
/** Zahnrad um (66,1|27): acht Zähne, Kopfkreis 12,5, Fußkreis 9,6, Nabe 4 (per evenodd ausgespart). */
const HUB_GEAR =
  "M64.15 17.6L64.34 14.62A12.5 12.5 0 0 1 67.86 14.62L68.05 17.6A9.6 9.6 0 0 1 71.37 18.98L73.61 17A12.5 12.5 0 0 1 76.1 19.49L74.12 21.73A9.6 9.6 0 0 1 75.5 25.05L78.48 25.24A12.5 12.5 0 0 1 78.48 28.76L75.5 28.95A9.6 9.6 0 0 1 74.12 32.27L76.1 34.51A12.5 12.5 0 0 1 73.61 37L71.37 35.02A9.6 9.6 0 0 1 68.05 36.4L67.86 39.38A12.5 12.5 0 0 1 64.34 39.38L64.15 36.4A9.6 9.6 0 0 1 60.83 35.02L58.59 37A12.5 12.5 0 0 1 56.1 34.51L58.08 32.27A9.6 9.6 0 0 1 56.7 28.95L53.72 28.76A12.5 12.5 0 0 1 53.72 25.24L56.7 25.05A9.6 9.6 0 0 1 58.08 21.73L56.1 19.49A12.5 12.5 0 0 1 58.59 17L60.83 18.98A9.6 9.6 0 0 1 64.15 17.6Z" +
  "M70.1 27a4 4 0 1 0 -8 0a4 4 0 1 0 8 0Z";
const HUB_BUBBLE = "M58 8H72A6 6 0 0 1 78 14V20A6 6 0 0 1 72 26H64L56.5 30.5L59 26H58A6 6 0 0 1 52 20V14A6 6 0 0 1 58 8Z";
const HUB_BUBBLE_DOTS =
  "M57.2 17a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0ZM63.2 17a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0ZM69.2 17a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0Z";
/**
 * Die rechte Kante der Zeichnung: 78,6, bei allen drei gleich — Ecke des
 * Ausweises, Zahnkopf, Sprechblase samt Strich. Die viewBox legt sie genau auf
 * den rechten Rand der Fläche. Erst damit misst `right` am Bildplatz bis zur
 * GEZEICHNETEN Kante und nicht bis zu einem leeren Rest der Fläche; siehe
 * `sectionCardIllu`.
 */
const HUB_VIEWBOX = "-1.4 0 80 72";
/** Headset in Bos Einheiten, damit es um seine Kuppe sitzt: Bügel, Mikrofonarm, Muscheln samt Mikrofon. */
const HUB_HEADBAND = "M25.03 118 A75 75 0 0 1 174.97 118";
const HUB_MIC_BOOM = "M175 140 Q176 170 130 168";
const HUB_HEADSET_FILL =
  "M25 102a11 11 0 0 1 11 11v16a11 11 0 0 1 -22 0v-16a11 11 0 0 1 11 -11Z" +
  "M175 102a11 11 0 0 1 11 11v16a11 11 0 0 1 -22 0v-16a11 11 0 0 1 11 -11Z" +
  "M118 168a8 8 0 1 0 16 0a8 8 0 1 0 -16 0Z";

/**
 * Fläche, Bos Verlauf und sein Schatten am Boden — gleich für alle drei.
 *
 * Die Verlaufs-ID ist je Bild eine eigene: Auf dem Web teilen sich alle SVGs
 * einer Seite einen ID-Raum.
 */
function HubIllu({ gid, children }: { gid: string; children: ReactNode }) {
  return (
    <Svg width={80} height={72} viewBox={HUB_VIEWBOX}>
      <Defs>
        <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#FFFFFF" />
          <Stop offset="1" stopColor="#E9ECEC" />
        </LinearGradient>
      </Defs>
      <Ellipse cx={30} cy={67.5} rx={13} ry={2} fill="#000000" fillOpacity={0.35} />
      {children}
    </Svg>
  );
}

/**
 * Bo selbst, an seinem festen Platz.
 *
 * Die Miene steht je Bild fest und wechselt nie — die Verzweigungen unten
 * hängen also nichts zur Laufzeit ein oder aus.
 */
function HubBo({
  gid,
  face,
  accent,
  arm,
  children,
}: {
  gid: string;
  face: "smile" | "wink" | "laugh";
  accent: string;
  /** Drehung des Winke-Arms um die Schulter; ohne Angabe kein Arm. */
  arm?: string;
  /** Was Bo trägt, in seinen Einheiten. */
  children?: ReactNode;
}) {
  const wink = face === "wink";
  return (
    <G transform={HUB_BO_AT}>
      {arm ? (
        <Path d={BO_ARM} transform={arm} stroke="#FFFFFF" strokeWidth={18} strokeLinecap="round" fill="none" />
      ) : null}
      <Path d={BO_BODY} fill={`url(#${gid})`} />
      <Path d={BO_CHEEKS} fill={accent} fillOpacity={0.5} />
      <Path d={wink ? BO_EYE_L : BO_EYES} fill={BO_INK} />
      <Path d={wink ? BO_GLINT_L : BO_GLINTS} fill={BO_GLINT} />
      {wink ? <Path d={BO_WINK} stroke={BO_INK} strokeWidth={7} strokeLinecap="round" fill="none" /> : null}
      {face === "laugh" ? (
        <Path d={BO_LAUGH} fill={BO_INK} />
      ) : (
        <Path d={wink ? BO_SMIRK : BO_SMILE} stroke={BO_INK} strokeWidth={5.5} strokeLinecap="round" fill="none" />
      )}
      {children}
    </G>
  );
}

/**
 * `memo`, weil der Hub die Kacheln bei jedem Durchgang neu anlegt (Anmeldung,
 * Sprache). Neu zeichnen müssen die Bilder nur bei einem anderen Akzent, und den
 * holt sich jedes selbst.
 */
const IlluDetails = memo(function IlluDetails() {
  const accent = useAccent();
  return (
    <HubIllu gid="hubBoDetails">
      <HubBo gid="hubBoDetails" face="smile" accent={accent.solid} />
      {/* Sein Ausweis, mit seinem eigenen Bild und einem Schloss für den Datenschutz. */}
      <G transform="rotate(-10 62 41)">
        <Rect x={47} y={31} width={30} height={20} rx={3.2} fill="#212123" stroke={accent.solid} strokeWidth={1.2} />
        <Rect x={50} y={34} width={10} height={12} rx={2} fill={accent.solid} fillOpacity={0.25} />
        {/* Der Mini-Bo: Körper mit ausgesparten Augen, also ein Pfad. */}
        <Path
          d={BO_BODY + BO_EYES}
          transform="translate(49.72 33.67) scale(0.053)"
          fill="#FFFFFF"
          fillRule="evenodd"
        />
        <Path d="M63 37.5h10" stroke={accent.solid} strokeWidth={2} strokeLinecap="round" />
        <Path d="M63 41.8h7M63 46h9" stroke="#56565C" strokeWidth={1.6} strokeLinecap="round" />
        <Path d={HUB_LOCK} fill={accent.solid} />
      </G>
    </HubIllu>
  );
});

const IlluSettings = memo(function IlluSettings() {
  const accent = useAccent();
  return (
    <HubIllu gid="hubBoSettings">
      <Path d={HUB_GEAR} fill={accent.solid} fillRule="evenodd" />
      {/* Bo greift mit dem Winke-Arm ins Zahnrad und zwinkert dabei. */}
      <HubBo gid="hubBoSettings" face="wink" accent={accent.solid} arm="rotate(28 150 132)" />
    </HubIllu>
  );
});

const IlluSupport = memo(function IlluSupport() {
  const accent = useAccent();
  return (
    <HubIllu gid="hubBoSupport">
      <Path d={HUB_BUBBLE} fill="#212123" stroke={accent.solid} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={HUB_BUBBLE_DOTS} fill={accent.solid} />
      <HubBo gid="hubBoSupport" face="laugh" accent={accent.solid}>
        <Path d={HUB_HEADBAND} stroke={accent.solid} strokeWidth={9} strokeLinecap="round" fill="none" />
        <Path d={HUB_MIC_BOOM} stroke={accent.solid} strokeWidth={6} strokeLinecap="round" fill="none" />
        <Path d={HUB_HEADSET_FILL} fill={accent.solid} />
      </HubBo>
    </HubIllu>
  );
});

/* ─────────────────────── STYLES ─────────────────────── */
const styles = scaledStyles({
  safe: { flex: 1, backgroundColor: C.bg },

  eyebrow: {
    fontSize: 11,
    fontWeight: "600",
    color: C.g3,
    letterSpacing: 0.88,
    marginBottom: 8,
  },

  /* — profile card — */
  profileCard: {
    marginHorizontal: GUTTER,
    // Erstes Element unter der Überschrift → geteilter Abstand. Stand auf 12 und
    // war damit 4px enger als in Saved.
    marginTop: HEADING_GAP,
    backgroundColor: C.s1,
    borderRadius: 22,
    overflow: "hidden",
  },
  profileTopRow: {
    paddingHorizontal: SPACE.lg,
    paddingTop: 16,
    paddingBottom: 16,
    flexDirection: "row",
    alignItems: "center",
  },
  profileName: {
    fontSize: 28,
    fontWeight: "900",
    color: C.white,
    letterSpacing: -0.84,
    lineHeight: 31,
  },
  profileEmail: { fontSize: 12, color: C.g2, marginTop: 8 },

  avatarWrap: { width: 58, height: 58 },
  avatar: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 20, fontWeight: "700", color: "#000" },
  avatarRing: {
    position: "absolute",
    top: -3,
    right: -3,
    bottom: -3,
    left: -3,
    borderRadius: 32,
    borderWidth: 1.5,
    borderColor: "rgba(127,234,77,0.35)",
  },
  avatarStatusDot: {
    position: "absolute",
    bottom: 2,
    right: 2,
    width: 13,
    height: 13,
    borderRadius: 6.5,
    backgroundColor: C.green,
    borderWidth: 2,
    borderColor: C.s1,
  },

  profileStatsRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  statCol: { flex: 1, paddingVertical: 8, alignItems: "center" },
  statColDivider: { borderRightWidth: 1, borderRightColor: C.border },
  statVal: { fontSize: 13, fontWeight: "700", color: C.white },
  statLbl: { fontSize: 10, color: C.g3, marginTop: 4, letterSpacing: 0.3 },

  /* — section card — */
  sectionCard: {
    backgroundColor: C.s1,
    borderRadius: 20,
    paddingHorizontal: SPACE.lg,
    paddingTop: 20,
    paddingBottom: 16,
    minHeight: 120,
    overflow: "hidden",
    position: "relative",
  },
  /**
   * Rechts derselbe Abstand wie der Text links: `SPACE.lg`, wie
   * `sectionCard.paddingHorizontal`. Beide laufen durch `scaledStyles`, bleiben
   * also auch auf kurzen Geräten gleich. Die SVG-Fläche selbst skaliert nicht
   * mit; ihre viewBox legt die gezeichnete Kante genau auf ihren Rand (siehe
   * `HUB_VIEWBOX`). Vorher stand hier 4, und die Bilder klebten mit 5 bis 9 dp
   * am Rand.
   */
  sectionCardIllu: { position: "absolute", top: 4, right: SPACE.lg, opacity: 0.92 },
  sectionCardTextWrap: { maxWidth: "58%", zIndex: 1 },
  sectionCardTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: C.white,
    letterSpacing: -0.5,
    lineHeight: 23,
  },
  sectionCardDesc: { fontSize: 12, color: C.g2, marginTop: 4, lineHeight: 17 },

  /* — divider, sign-out, version — */
  divider: { height: 1, backgroundColor: C.border, marginHorizontal: GUTTER, marginTop: 16 },
  stack: { flex: 1 },
  layer: { ...StyleSheet.absoluteFillObject },
  /** Die Auswahl-Ebene in der Einstellungs-Slide — füllt sie, damit sie als Ganzes ausweichen kann. */
  subLayer: { flex: 1 },
  subSheet: {
    // Gerundete Ecken beim Hereinfahren, passend zum Geräte-Display — wie bei
    // allen anderen Slides der App.
    borderRadius: SCREEN_CORNER_RADIUS,
    overflow: "hidden",
  },
  signOut: {
    marginHorizontal: GUTTER,
    marginTop: 12,
    backgroundColor: "rgba(255,69,58,0.05)",
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  signOutText: { fontSize: 15, fontWeight: "600", color: C.red },
  signIn: {
    marginHorizontal: GUTTER,
    marginTop: 12,
    backgroundColor: "rgba(127,234,77,0.05)",
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  signInText: { fontSize: 15, fontWeight: "600", color: C.green },
  versionText: {
    textAlign: "center",
    fontSize: 11,
    color: C.g3,
    paddingTop: 16,
    paddingBottom: 8,
  },

  /* — back header — */
  backHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: GUTTER,
    // Derselbe Takt wie die Überschrift im Hub, damit der Titel beim
    // Hereinfahren genau dort landet, wo „Profil" stand.
    paddingTop: HEADING_TOP,
    paddingBottom: 0,
  },
  /**
   * Das X steht FREI, ohne Kreis — genau wie in Bos Kopfzeile (Größe, Farbe,
   * Strich). Innenabstand plus negativer Außenabstand ergibt eine echte
   * 44er-Fläche, ohne dass die Zeile höher wird oder das Zeichen wandert.
   */
  backHeaderBtn: {
    padding: (44 - CLOSE_ICON_SIZE) / 2,
    margin: -(44 - CLOSE_ICON_SIZE) / 2,
    alignItems: "center",
    justifyContent: "center",
  },

  /* — section labels — */
  sLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: C.g3,
    letterSpacing: 0.88,
    paddingHorizontal: GUTTER,
    paddingTop: SECTION_GAP,
    paddingBottom: TITLE_GAP,
  },

  /* — group / row — */
  group: {
    backgroundColor: C.s1,
    borderRadius: 16,
    marginHorizontal: GUTTER,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: C.border },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: { fontSize: 15, color: C.white },
  rowSub: { fontSize: 12, color: C.g2, marginTop: 4 },
  rowValue: { fontSize: 14, color: C.g2 },

  /* — Kategorie-Seiten — */
  /** Zwischen Überschrift und erster Karte: derselbe Abstand wie die Profil-Karte im Hub. */
  pageTop: { height: HEADING_GAP },
  cardGap: { height: GROUP_GAP },
  /** Hinweis an der Stelle der Bedienung, wenn sie ohne Anmeldung nicht geht. */
  cardHint: { fontSize: 12.5, lineHeight: 17, color: C.white, fontWeight: "500" },

  /* — Bos Gedächtnis — */
  boMemState: { paddingHorizontal: 16, paddingVertical: 16 },
  /** Fläche für Warten und Lader — so hoch wie der Lader mit Rand, damit beim Erscheinen nichts springt. */
  boMemLoading: { minHeight: 68, paddingVertical: 16 },
  boMemEmpty: { fontSize: 13, lineHeight: 19, color: C.g2 },
  boMemItem: { paddingLeft: 16 },
  boMemBody: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingRight: 8,
    paddingVertical: 8,
  },
  boMemText: { flex: 1, fontSize: 14.5, lineHeight: 20, color: C.white },
  boMemDelete: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },

  /* — details large avatar — */
  avatarLargeOuter: {
    alignItems: "center",
    paddingTop: 20,
    paddingBottom: 24,
    gap: 8,
  },
  avatarLargeWrap: { width: 80, height: 80, position: "relative" },
  avatarLarge: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLargeText: { fontSize: 28, fontWeight: "700", color: "#000" },
  avatarEditDot: {
    position: "absolute",
    bottom: 2,
    right: 2,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: C.green,
    alignItems: "center",
    justifyContent: "center",
  },
  editPhotoText: {
    fontSize: 13,
    fontWeight: "600",
    color: C.green,
  },

  /* — FAQ — */
  faqRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  faqQ: { flex: 1, fontSize: 14, fontWeight: "500", color: C.white, paddingRight: 12 },
  faqA: { paddingHorizontal: 16, paddingBottom: 16, fontSize: 13, color: C.g2, lineHeight: 19 },
  sourcesNote: { paddingHorizontal: GUTTER, paddingTop: 8, fontSize: 12, color: C.g3, lineHeight: 17 },
});

/* ─────────────────────── UNTERSCHIRM-ÜBERLAGERUNG ─────────────────────── */
/**
 * Die Unterschirme des Profil-Tabs — am WURZEL-Layout, nicht im Tab.
 *
 * Im Tab lag die Ebene innerhalb des nativen Tab-Containers und endete damit
 * über der Leiste: Die Slide bedeckte nur einen Ausschnitt, und ihre gerundeten
 * Ecken standen mitten im Bild statt an den Bildschirmecken. Von hier aus deckt
 * sie den ganzen Bildschirm ab, und die Rundung sitzt dort, wo das Display
 * ohnehin rund ist.
 *
 * Verbunden sind die beiden Bäume über `settingsPush` (Bewegung, UI-Thread) und
 * `settingsSub` (welcher Inhalt, Speicher).
 */
/**
 * Steht der Unterschirm still?
 *
 * Falsch, solange er hereinfährt. `BelowFold` hängt daran — die Begründung
 * steht dort.
 */
const SubSettledContext = createContext(true);

/**
 * Alles, was beim Hereinfahren noch nicht zu sehen ist, entsteht erst danach.
 *
 * Gebaut für die frühere Sammel-Seite „Einstellungen", die mehrere Bildschirme
 * hoch war (Themen-Karten, Farbreihe, Sprachen, Währungen, Schalter) — ein paar
 * hundert Ansichten, die Fabric auf DEMSELBEN Strang aufbaut, auf dem die
 * Bewegung läuft. Seit sie in kurze Kategorie-Seiten zerlegt ist (28.10.2026),
 * nutzen es noch „Deine Daten" und „Support".
 *
 * Der Aufbau war schon um ein Bild nach hinten geschoben, aber das verschiebt
 * die Kosten nur, es senkt sie nicht — sie landen dann eben in den ersten
 * Bildern der Fahrt. Hier wird stattdessen gar nicht erst gebaut, was während
 * der Fahrt niemand sehen kann: Sichtbar ist nur der oberste Bildschirm, der
 * Rest steht darunter. Sobald die Bewegung durch ist, kommt er nach — dann
 * bewegt sich nichts mehr, und der Aufbau stört keine Animation.
 *
 * Sichtbar wird davon nichts: Man kann während der Fahrt nicht scrollen, und
 * oben ändert sich die Anordnung nicht.
 */
function BelowFold({ children }: { children: ReactNode }) {
  return useContext(SubSettledContext) ? <>{children}</> : null;
}

export function SettingsSubOverlay() {
  const appBg = useAppBg();
  const sub = useSearchStore((s) => s.settingsSub);
  const setSettingsSub = useSearchStore((s) => s.setSettingsSub);
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();

  /**
   * Was gerade ANGEZEIGT wird — nicht, was gewählt ist.
   *
   * Beim Zurückgehen fällt `settingsSub` sofort auf null, der Inhalt muss aber
   * noch stehen, solange er hinausfährt. Abgeräumt wird er erst, wenn die
   * Bewegung durch ist.
   */
  const [display, setDisplay] = useState<SubScreen>(null);
  /**
   * Schon beim Berühren der Kachel aufbauen, nicht erst beim Loslassen.
   *
   * Der Baum steht danach geparkt rechts außerhalb (`settingsPush` ist 0) — zu
   * sehen ist nichts. Beim Loslassen bleibt nur noch das Schieben, und der
   * Aufbau liegt im Berührungsfenster statt im Bild vor der Bewegung.
   */
  useEffect(() => subscribeSettingsPreload((id: SettingsSubId) => setDisplay(id)), []);
  /** Läuft die Bewegung? Nur dann eine GPU-Ebene. */
  const [moving, setMoving] = useState(false);
  /**
   * Ist der Unterschirm ANGEKOMMEN? Daran hängt `BelowFold`.
   *
   * Bewusst NICHT `moving` — das steht auch beim Hinausfahren auf wahr. Der
   * untere Teil würde dann mitten in der Rückfahrt verschwinden, während man
   * ihm zusieht. Diese Marke geht nur beim HEREINfahren auf falsch und bleibt
   * danach wahr, bis der Unterschirm ganz abgeräumt ist.
   */
  const [settled, setSettled] = useState(false);

  /**
   * ZWEITE EBENE — Einstellungen → Kategorie.
   *
   * Fährt wie die erste von rechts herein, aber INNERHALB der Einstellungs-Slide,
   * und die Auswahl darunter weicht um denselben Anteil nach links aus wie der
   * Hub unter der ersten Ebene. `id` bleibt stehen, solange die Seite hinausfährt;
   * `open` fällt dafür schon mit dem Start der Rückfahrt (keine Berührung mehr).
   * Lokaler Zustand statt Speicher: Er gehört nur dieser Fläche, und ein
   * Speicher-Schreibvorgang weckte alle Abonnenten der App.
   */
  const [cat, setCat] = useState<{ id: SettingsCategoryId | null; open: boolean; moving: boolean }>({
    id: null,
    open: false,
    moving: false,
  });
  const categoryPush = useSharedValue(0);
  const catRef = useRef(cat);
  catRef.current = cat;
  /** Beim Berühren der Zeile vorbauen (wie die Kacheln im Hub) — nie über eine offene Seite hinweg. */
  const preloadCategory = useCallback((id: SettingsCategoryId) => {
    setCat((c) => (c.open || c.moving || c.id === id ? c : { ...c, id }));
  }, []);
  const endCategoryOpen = useCallback(() => setCat((c) => ({ ...c, moving: false })), []);
  const endCategoryClose = useCallback(() => setCat({ id: null, open: false, moving: false }), []);
  const openCategory = useCallback(
    (id: SettingsCategoryId) => {
      if (catRef.current.open) return;
      haptic("button");
      // Erst aufbauen (dieser Durchgang), DANN fahren — ein Bild später, wie die erste Ebene.
      setCat({ id, open: true, moving: true });
      requestAnimationFrame(() => {
        markTransitionBusy(PUSH_SPRING.duration);
        categoryPush.value = withTiming(1, slideTiming(PUSH_SPRING), (finished?: boolean) => {
          "worklet";
          if (finished) runOnJS(endCategoryOpen)();
        });
      });
    },
    [categoryPush, endCategoryOpen],
  );
  const closeCategory = useCallback(() => {
    if (!catRef.current.open) return;
    haptic("button");
    setCat((c) => ({ ...c, open: false, moving: true }));
    markTransitionBusy(POP_SPRING.duration);
    requestAnimationFrame(() => {
      categoryPush.value = withTiming(0, slideTiming(POP_SPRING), (finished?: boolean) => {
        "worklet";
        if (finished) runOnJS(endCategoryClose)();
      });
    });
  }, [categoryPush, endCategoryClose]);

  /**
   * ERST aufbauen, DANN bewegen.
   *
   * Der Auslöser im Hub setzt nur noch den Speicher. Dieser Effekt baut daraufhin
   * den Unterschirm auf — und startet die Feder erst im NÄCHSTEN Bild. Vorher
   * lief beides im selben Moment los: Die Feder startete im Berührungs-Frame,
   * während der Baum des Unterschirms (Details, Einstellungen, Support — jeweils
   * mehrere Bildschirme hoch, mit eigenen Grafiken) im Commit unmittelbar danach
   * entstand. Fabric baut den auf demselben Thread auf, auf dem die Bewegung
   * läuft; sie lief also gegen ihn an. Genau daran lag der Ruckler.
   */
  /**
   * `display` als Abhängigkeit hätte den Start VERZÖGERT — den er eigentlich
   * beschleunigen sollte.
   *
   * Der Effekt setzt `display` selbst. Stand es mit in der Liste, lief er nach
   * genau diesem Setzen ein zweites Mal an, und sein Aufräumen nahm dabei die
   * eben angeforderte Startanforderung zurück. Die Bewegung fing also erst nach
   * einem WEITEREN vollen Durchlauf an — zwei Bilder, in denen auf den Finger
   * hin nichts passiert. Genau das liest sich als Verzögerung.
   *
   * Der Wert wird trotzdem gebraucht, aber nur GELESEN, und dafür genügt eine
   * Ablage: sie erzwingt keinen erneuten Durchlauf.
   */
  const displayRef = useRef<SubScreen>(null);
  displayRef.current = display;
  useEffect(() => {
    if (sub) {
      setDisplay(sub);
      setMoving(true);
      setSettled(false);
      const id = requestAnimationFrame(() => {
        /**
         * Die Bewegung ANMELDEN — hier fehlte es als einzigem Übergang der App.
         *
         * Zwei Dinge hängen daran, und beide fielen bisher ungeschützt in diese
         * Fahrt: Die Persistenz des Speichers serialisiert über 50 KB und
         * braucht dafür 10 bis 30ms auf dem JS-Strang; sie wartet auf eine
         * Leerlauf-Lücke, und die ist während einer Bewegung erfüllt (die läuft
         * ja auf dem UI-Strang). Und der Riegel in `transitionLayer.ts` lässt
         * eine GPU-Ebene nur dann nicht abreißen, wenn eine Fahrt angemeldet
         * ist — ohne die Anmeldung konnte die 1,4-Sekunden-Frist der
         * Hub-Textur mitten hineinfallen.
         */
        markTransitionBusy(PUSH_SPRING.duration);
        setSheetMoving(true, "settingsSub");
        // Die Textur des Hubs halten, solange der Unterschirm darüber liegt —
        // sie ist beim Berühren angefordert worden und verfiele sonst nach
        // 1,4 Sekunden, also lange vor dem Zurückgehen.
        holdLayer("settings");
        settingsPush.value = 0;
        settingsPush.value = withTiming(1, slideTiming(PUSH_SPRING), (finished?: boolean) => {
          "worklet";
          if (finished) {
            runOnJS(setMoving)(false);
            runOnJS(setSettled)(true);
          }
        });
      });
      /**
       * Notausgang, falls die Bewegung nie ans Ziel kommt.
       *
       * Der Rückruf oben meldet sich bei einer ABGEBROCHENEN Bewegung mit
       * `finished === false` — dann bliebe `moving` stehen. Das war früher
       * harmlos (nur eine GPU-Ebene zu viel); seit `BelowFold` daran hängt,
       * bliebe der halbe Bildschirm leer, und zwar dauerhaft. Der Zeitgeber
       * kostet nichts und macht diesen Ausgang unmöglich.
       */
      const safety = setTimeout(() => {
        setMoving(false);
        setSettled(true);
      }, PUSH_SPRING.duration + 120);
      return () => {
        cancelAnimationFrame(id);
        clearTimeout(safety);
      };
    }
    if (!displayRef.current) return;
    const id = setTimeout(() => {
      setDisplay(null);
      setMoving(false);
      // Die zweite Ebene gehört zur ersten — beim nächsten Öffnen steht wieder die Auswahl da.
      setCat({ id: null, open: false, moving: false });
      categoryPush.value = 0;
      /**
       * Mit Abstand — siehe Bo. Bildgenau auf das Kurvenende gesetzt, reißt
       * dieser Wecker den Unterschirm-Baum rund ein Bild zu früh ab, und
       * `setTimeout` trifft ohnehin nicht das Bild.
       */
    }, POP_SPRING.duration + 120);
    return () => clearTimeout(id);
  }, [sub]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - settingsPush.value) * screenW }],
  }));

  /** Wecker für das späte Leeren — siehe `back`. Muss beim Abbau sterben. */
  const clearSubRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (clearSubRef.current) clearTimeout(clearSubRef.current);
    },
    [],
  );

  const back = useCallback(() => {
    haptic("button");
    /**
     * Erst die Bewegung, dann der Speicher — die Reihenfolge war umgekehrt.
     *
     * `setSettingsSub(null)` weckt jeden Abonnenten, und der daraus folgende
     * Commit läuft bei einem Loslass-Ereignis SYNCHRON zu Ende. Er lag damit vor
     * dem Start der Rückfahrt. `setMoving(true)` schaltet obendrein die
     * GPU-Ebene — auch das im selben Durchgang.
     *
     * Jetzt läuft es wie auf dem Hinweg: Textur an, ein Bild zum Zeichnen, dann
     * fahren — und der Speicher-Schreibvorgang erst danach, wo er niemanden
     * mehr stört. Das Blatt bleibt in diesem Bild ohnehin stehen, sichtbar
     * ändert sich also nichts.
     */
    setMoving(true);
    // Rückfahrt genauso anmelden — sie ist der Regelfall, in den die
    // Leerlauf-Arbeit fällt: Man stellt etwas ein, und Sekunden später geht man
    // zurück. Die Uhr des Schreibvorgangs läuft dann mit hoher
    // Wahrscheinlichkeit genau dort hinein.
    markTransitionBusy(POP_SPRING.duration);
    // Und die Hub-Textur für die Rückfahrt wieder scharf stellen.
    rearmLayer("settings");
    requestAnimationFrame(() => {
      settingsPush.value = withTiming(0, slideTiming(POP_SPRING), (finished?: boolean) => {
        "worklet";
        if (!finished) return;
        runOnJS(setSheetMoving)(false, "settingsSub");
      });
    });
    /**
     * Der Speicher-Schreibvorgang liegt HINTER der Kurve, nicht in ihrem
     * ersten Bild.
     *
     * Er stand im selben rAF-Rückruf wie der Kurvenstart — also genau dort, wo
     * er nicht sein soll: Er weckt über 140 Selektoren und kippt zusätzlich
     * `pointerEvents` auf dem animierten Knoten. Der Inhalt bleibt bis dahin
     * über die Anzeige-Ablage stehen, es ist also nichts zu sehen.
     */
    if (clearSubRef.current) clearTimeout(clearSubRef.current);
    clearSubRef.current = setTimeout(() => {
      clearSubRef.current = null;
      setSettingsSub(null);
    }, POP_SPRING.duration + 120);
  }, [setSettingsSub]);

  /**
   * Android-Zurück (Taste UND Wisch-Geste, beides feuert dieses Ereignis).
   *
   * Nötig, seit der Unterschirm am Wurzel-Layout hängt statt im Tab: Er ist kein
   * Router-Bildschirm, hat also kein eingebautes Zurück. Ohne das schloss die
   * Zurück-Geste die ganze App, obwohl sichtbar ein Bildschirm darüber lag.
   */
  useEffect(() => {
    if (Platform.OS !== "android" || !sub) return;
    const h = BackHandler.addEventListener("hardwareBackPress", () => {
      // Erst die Kategorie zurück zur Auswahl, dann die Einstellungen zum Hub.
      if (catRef.current.open) closeCategory();
      else back();
      return true; // verbraucht — sonst schlösse Android die App.
    });
    return () => h.remove();
  }, [sub, back, closeCategory]);

  /** Die Auswahl weicht nach links aus, während die Kategorie hereinfährt. */
  const menuShiftStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: categoryPush.value * screenW * UNDERLAY_TRAVEL_FRAC }],
  }));
  const categoryStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - categoryPush.value) * screenW }],
  }));
  const categorySheetStyle = useMemo(
    () => [StyleSheet.absoluteFillObject, styles.subSheet, { backgroundColor: appBg, zIndex: 91 }, categoryStyle],
    [appBg, categoryStyle],
  );

  /**
   * Beide Ablagen liegen VOR dem Ausstieg unten.
   *
   * Hooks müssen in jedem Durchgang in derselben Zahl und Reihenfolge laufen.
   * Standen sie hinter `if (!display) return null`, lief die Komponente
   * geschlossen mit zwei Hooks weniger — und beim Öffnen brach React genau
   * deshalb ab.
   */
  const subSheetChrome = useMemo(
    () => ({ backgroundColor: appBg, zIndex: 90 }),
    [appBg],
  );
  const subSheetStyle = useMemo(
    () => [StyleSheet.absoluteFillObject, styles.subSheet, subSheetChrome, style],
    [subSheetChrome, style],
  );

  if (!display) return null;

  return (
    <Animated.View
      /**
       * Nur anfassbar, wenn wirklich geöffnet.
       *
       * Seit der Baum schon beim BERÜHREN der Kachel entsteht, steht er auch
       * dann im Bild, wenn nur vorgebaut wurde — geparkt rechts außerhalb, also
       * unsichtbar. Ohne diese Zeile könnte er am Rand trotzdem Berührungen
       * abfangen; mit ihr ist ausgeschlossen, dass der Vorbau irgendetwas am
       * Verhalten ändert.
       */
      pointerEvents={sub ? "auto" : "none"}
      style={subSheetStyle}
      // Für die DAUER der Bewegung eine GPU-Ebene: Der Unterschirm ist ein
      // langer Baum mit eigenen Grafiken und würde sonst in jedem Bild der
      // Bewegung neu gezeichnet. Dauerhaft darf sie nicht sein — dann entstünde
      // sie bei jedem Scrollen darin neu.
      renderToHardwareTextureAndroid={Platform.OS === "android" && moving}
    >
      <Animated.View
        style={[styles.subLayer, menuShiftStyle]}
        // Weicht die Auswahl aus, wird sie wie der Hub als Ebene geschoben statt Bild für Bild neu gezeichnet.
        renderToHardwareTextureAndroid={Platform.OS === "android" && cat.moving}
      >
        <Animated.ScrollView
          scrollEventThrottle={16}
          // key an den Unterschirm gebunden: Sonst behielte die Fläche ihren
          // Scroll-Stand vom vorherigen Unterschirm.
          key={display}
          contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + 24 }}
          showsVerticalScrollIndicator={false}
        >
          <SubSettledContext.Provider value={settled}>
            {display === "details" && <DetailsScreen onBack={back} />}
            {display === "settings" && (
              <SettingsMenuScreen onBack={back} onOpen={openCategory} onPreload={preloadCategory} />
            )}
            {display === "support" && <SupportSubScreen onBack={back} />}
          </SubSettledContext.Provider>
        </Animated.ScrollView>
      </Animated.View>
      {display === "settings" && cat.id ? (
        <Animated.View
          // Vorgebaut, aber nicht offen: geparkt rechts außerhalb und nicht anfassbar.
          pointerEvents={cat.open ? "auto" : "none"}
          style={categorySheetStyle}
          renderToHardwareTextureAndroid={Platform.OS === "android" && cat.moving}
        >
          <Animated.ScrollView
            scrollEventThrottle={16}
            key={cat.id}
            // „Zuhause" sucht mit offener Tastatur — der erste Tipp auf einen
            // Treffer soll ihn wählen, nicht nur die Tastatur schließen.
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + 24 }}
            showsVerticalScrollIndicator={false}
          >
            {cat.id === "travel" && <TravelScreen onBack={closeCategory} />}
            {cat.id === "appearance" && <AppearanceScreen onBack={closeCategory} />}
            {cat.id === "language" && <LanguageScreen onBack={closeCategory} />}
            {cat.id === "notifications" && <NotificationsScreen onBack={closeCategory} />}
            {cat.id === "bo" && <BoScreen onBack={closeCategory} />}
          </Animated.ScrollView>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}
