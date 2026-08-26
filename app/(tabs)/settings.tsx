import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState, useMemo } from "react";
import { subscribeLayer, prepareLayer, holdLayer, rearmLayer } from "@/lib/nav/transitionLayer";
import { markTransitionBusy } from "@/lib/nav/transitionBusy";
import { setSheetMoving } from "@/lib/nav/searchHandoff";
import {
  preloadSettingsSub,
  subscribeSettingsPreload,
  type SettingsSubId,
} from "@/lib/nav/settingsPreload";
import { OnFocusLost } from "@/lib/nav/FocusSentinel";
import {
  Platform,
  BackHandler,
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  Switch,
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
import { GUTTER, SPACE, HEADING_TOP, HEADING_GAP, useNavbarSpace } from "@/lib/theme/spacing";
import { ScreenHeading } from "@/components/ui/ScreenHeading";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import {
  ChevronRight,
  Check,
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
} from "lucide-react-native";
import { useSearchStore, Locale } from "@/stores/searchStore";
import { useAccent, ACCENT_LIST, type AccentId } from "@/lib/theme/accent";
import { useAppBg, usePalette } from "@/lib/theme/appBg";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { authLogout, authUpdateAvatar } from "@/lib/api/client";
import { showAlert } from "@/lib/alert";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { scaledStyles } from "@/lib/ui/compact";

const C = {
  bg: "#1A1A1A",
  s1: "#1F1F20",
  s2: "#242425",
  s3: "#2A2A2C",
  border: "#2E2E30",
  green: "#7FEA4D",
  greenDark: "#2BB857",
  greenSubtle: "#1A3D26",
  white: "#FFFFFF",
  g1: "#C8C8CC",
  g2: "#8A8A90",
  g3: "#56565C",
  red: "#FF453A",
};

function makeInitials(firstName: string, lastName: string): string {
  const f = firstName.trim()[0] ?? "";
  const l = lastName.trim()[0] ?? "";
  const out = (f + l).toUpperCase();
  return out || "?";
}

type SubScreen = "details" | "settings" | "support" | null;

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
          onPress: async () => {
            haptic("important");
            if (token) {
              try {
                await authLogout(token);
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
    <View style={[styles.profileCard, { backgroundColor: palette.s1 }]}>
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
            <View style={[styles.avatar, { backgroundColor: palette.s2, borderWidth: 1, borderColor: palette.border }]}>
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
        { backgroundColor: palette.s1 },
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
  const openAuth = useSearchStore((s) => s.openAuthOverlay);
  const [avatarBusy, setAvatarBusy] = useState(false);

  const fullName = user ? `${user.firstName} ${user.lastName}` : t("auth.guest.name");
  const initials = user ? makeInitials(user.firstName, user.lastName) : "?";

  const onPickPhoto = async () => {
    if (!user || !token || avatarBusy) return;
    haptic("button");
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
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
            <View style={[styles.avatarLarge, { backgroundColor: palette.s2, borderWidth: 1, borderColor: palette.border }]}>
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
          <View style={{ flexDirection: "row", gap: 14, alignItems: "center" }}>
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
      </BelowFold>

    </View>
  );
}

/* ─────────────────────── SETTINGS SUB ─────────────────────── */
const THEMES: { id: "dark" | "light" | "gray"; bg: string; surface: string }[] = [
  { id: "dark", bg: "#000000", surface: "#1A1A1A" },
  { id: "light", bg: "#F2F2F5", surface: "#FFFFFF" },
  { id: "gray", bg: "#1C1C1E", surface: "#2C2C2E" },
];

const LANGS: { id: Locale; label: string; flag: string }[] = [
  { id: "de", label: "Deutsch", flag: "DE" },
  { id: "en", label: "English", flag: "EN" },
  { id: "fr", label: "Français", flag: "FR" },
  { id: "es", label: "Español", flag: "ES" },
];

const CURRENCIES = ["EUR", "USD", "GBP", "JPY", "CHF", "SEK"];

function SettingsSubScreen({ onBack }: { onBack: () => void }) {
  const palette = usePalette();
  const t = useT();
  const theme = useSearchStore((s) => s.theme);
  const setTheme = useSearchStore((s) => s.setTheme);
  const accentId = useSearchStore((s) => s.accent);
  const setAccent = useSearchStore((s) => s.setAccent);
  const accent = useAccent();
  const locale = useSearchStore((s) => s.locale);
  const setLocale = useSearchStore((s) => s.setLocale);
  const currency = useSearchStore((s) => s.currency);
  const setCurrency = useSearchStore((s) => s.setCurrency);
  const hapticsEnabled = useSearchStore((s) => s.hapticsEnabled);
  const setHapticsEnabled = useSearchStore((s) => s.setHapticsEnabled);
  const notificationsEnabled = useSearchStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useSearchStore((s) => s.setNotificationsEnabled);
  const priceAlertsEnabled = useSearchStore((s) => s.priceAlertsEnabled);
  const setPriceAlertsEnabled = useSearchStore((s) => s.setPriceAlertsEnabled);
  const savedToastPosition = useSearchStore((s) => s.savedToastPosition);
  const setSavedToastPosition = useSearchStore((s) => s.setSavedToastPosition);

  return (
    <View>
      <BackHeader title={t("settings.title")} onBack={onBack} />

      {/* APPEARANCE — Theme-Karten mit Mock-UI im Preview, Footer wird bei
          Active accent-solid mit schwarzem Text + Check-Icon. */}
      <StripeLabel text={t("settings.appearance")} firstSection />
      <View style={styles.themeRow}>
        {THEMES.map((th) => {
          const active = theme === th.id;
          return (
            <Pressable
              key={th.id}
              onPress={() => {
                haptic("button");
                setTheme(th.id);
              }}
              style={[styles.themeCardOuter, { backgroundColor: active ? accent.solid : "transparent" }]}
            >
              <View style={[styles.themeCardInner, { borderColor: active ? "transparent" : C.border }]}>
                <View style={[styles.themePreview, { backgroundColor: th.bg, alignItems: th.id === "light" ? "center" : "stretch" }]}>
                  <View style={[styles.themePreviewBar, { backgroundColor: th.surface, width: th.id === "light" ? "78%" : "52%" }]} />
                  <View style={[styles.themePreviewBlock, { backgroundColor: th.surface, width: th.id === "light" ? "88%" : "100%" }]} />
                </View>
                <View style={[styles.themeFooter, { backgroundColor: active ? accent.solid : C.s2 }]}>
                  <Text style={[styles.themeFooterText, { color: active ? accent.textOnSolid : C.white }]}>
                    {t(`theme.label.${th.id}`)}
                  </Text>
                  {active && <Check size={16} color={accent.textOnSolid} strokeWidth={2.6} />}
                </View>
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* COLOR — Akzent-Paletten zur Auswahl. Swatch = flache Akzentfarbe
          (a.solid). Selected: schwarzer Kreis mit Check-Icon + solid Footer. */}
      <StripeLabel text={t("settings.color")} />
      <View style={styles.themeRow}>
        {ACCENT_LIST.map((a) => {
          const active = accentId === a.id;
          return (
            <Pressable
              key={a.id}
              onPress={() => {
                haptic("button");
                setAccent(a.id);
              }}
              style={[styles.themeCardOuter, { backgroundColor: active ? a.solid : "transparent" }]}
            >
              <View style={[styles.themeCardInner, { borderColor: active ? "transparent" : C.border }]}>
                {/* Flache Swatch statt Verlauf — konsistent mit der flachen
                    Akzent-Darstellung in der restlichen App (GradientFill). */}
                <View style={[styles.colorSwatch, { backgroundColor: a.solid }]}>
                  {active && (
                    <View style={styles.colorCheck}>
                      <Check size={14} color={a.solid} strokeWidth={3} />
                    </View>
                  )}
                </View>
                <View style={[styles.themeFooter, { backgroundColor: active ? a.solid : C.s2, justifyContent: "center" }]}>
                  <Text style={[styles.themeFooterText, { color: active ? a.textOnSolid : C.white }]}>
                    {t(`color.label.${a.id}`)}
                  </Text>
                </View>
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* LANGUAGE — Liste mit 44px Code-Badge links, Active-Highlight via
          accent.subtle. Code+Name fett wenn aktiv, Check rechts. */}
      <BelowFold>
      <StripeLabel text={t("settings.language")} />
      <Group>
        {LANGS.map((l, i) => {
          const active = locale === l.id;
          return (
            <Pressable
              key={l.id}
              onPress={() => {
                haptic("button");
                setLocale(l.id);
              }}
              style={[
                styles.row,
                i < LANGS.length - 1 && styles.rowDivider,
                active && { backgroundColor: accent.subtle },
              ]}
            >
              <View style={[styles.langBadge, { backgroundColor: active ? accent.subtle : C.s2 }]}>
                <Text style={[styles.langBadgeText, { color: active ? accent.solid : C.g2 }]}>
                  {l.flag}
                </Text>
              </View>
              <Text
                style={[
                  styles.rowLabel,
                  {
                    flex: 1,
                    color: active ? C.white : C.g1,
                    fontWeight: active ? "700" : "500",
                  },
                ]}
              >
                {l.label}
              </Text>
              {active && <Check size={16} color={accent.solid} strokeWidth={2.6} />}
            </Pressable>
          );
        })}
      </Group>

      {/* CURRENCY */}
      <StripeLabel text={t("settings.currency")} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.currencyRow}
      >
        {CURRENCIES.map((c) => {
          const active = currency === c;
          return (
            <Pressable
              key={c}
              onPress={() => {
                haptic("button");
                setCurrency(c);
              }}
              style={[
                styles.currencyPill,
                {
                  backgroundColor: active ? accent.solid : "transparent",
                  borderColor: active ? accent.solid : C.border,
                },
              ]}
            >
              <Text
                style={[
                  styles.currencyPillText,
                  { color: active ? accent.textOnSolid : C.g1, fontWeight: "700" },
                ]}
              >
                {c}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* HAPTICS & NOTIFICATIONS */}
      <StripeLabel text={t("settings.notifs.section")} />
      <Group>
        <ToggleRow
          icon={<IconHaptic />}
          label={t("settings.haptics.label")}
          desc={t("settings.haptics.desc")}
          value={hapticsEnabled}
          onChange={(v) => {
            setHapticsEnabled(v);
            if (v) haptic("button");
          }}
        />
        <ToggleRow
          icon={<IconBell />}
          label={t("settings.notifs.label")}
          desc={t("settings.notifs.desc")}
          value={notificationsEnabled}
          onChange={(v) => {
            haptic("button");
            setNotificationsEnabled(v);
          }}
        />
        <ToggleRow
          icon={<IconAlert />}
          label={t("settings.pricealerts.label")}
          desc={t("settings.pricealerts.desc")}
          value={priceAlertsEnabled}
          onChange={(v) => {
            haptic("button");
            setPriceAlertsEnabled(v);
          }}
          isLast
        />
      </Group>

      {/* SAVED TOAST POSITION */}
      <StripeLabel text={t("settings.toast.section")} />
      <View style={{ paddingHorizontal: GUTTER }}>
        <Text style={styles.toastDesc}>{t("settings.toast.desc")}</Text>
        <View style={[styles.toastSegment, { backgroundColor: palette.s3 }]}>
          {(["top", "bottom"] as const).map((pos) => {
            const active = savedToastPosition === pos;
            return (
              <Pressable
                key={pos}
                onPress={() => {
                  haptic("button");
                  setSavedToastPosition(pos);
                }}
                style={[
                  styles.toastSegmentItem,
                  active && { backgroundColor: accent.solid },
                ]}
              >
                <Text
                  style={[
                    styles.toastSegmentText,
                    { color: active ? accent.textOnSolid : C.g1, fontWeight: active ? "700" : "500" },
                  ]}
                >
                  {t(`settings.toast.${pos}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={{ height: 16 }} />
      </BelowFold>
    </View>
  );
}

/* ─────────────────────── SUPPORT ─────────────────────── */
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
        style={({ pressed }) => [styles.backHeaderBtn, pressed && { opacity: 0.7 }]}
      >
        <X size={16} color={C.white} strokeWidth={2.5} />
      </Pressable>
    </View>
  );
}

function SLabel({ text }: { text: string }) {
  return <Text style={styles.sLabel}>{text.toUpperCase()}</Text>;
}

function StripeLabel({ text, firstSection }: { text: string; firstSection?: boolean }) {
  const accent = useAccent();
  return (
    <View style={[styles.stripeLabel, firstSection && { paddingTop: 16 }]}>
      <View style={[styles.stripeBar, { backgroundColor: accent.solid }]} />
      <Text style={styles.stripeLabelText}>{text.toUpperCase()}</Text>
    </View>
  );
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
  isLast?: boolean;
  danger?: boolean;
  rightEl?: ReactNode;
}

function Row({ icon, iconBg, label, value, sub, onPress, isLast, danger, rightEl }: RowProps) {
  return (
    <RippleTouch
      onPress={onPress}
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

function ToggleRow({
  icon,
  label,
  desc,
  value,
  onChange,
  isLast,
}: {
  icon: ReactNode;
  label: string;
  desc?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  isLast?: boolean;
}) {
  const palette = usePalette();
  const accent = useAccent();
  return (
    <View style={[styles.row, !isLast && styles.rowDivider]}>
      <View style={[styles.rowIcon, { backgroundColor: palette.s2 }]}>{icon}</View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, { fontWeight: "500" }]}>{label}</Text>
        {desc ? <Text style={styles.rowSub}>{desc}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: C.s3, true: accent.solid }}
        thumbColor="#FFFFFF"
        ios_backgroundColor={C.s3}
      />
    </View>
  );
}

/* ─── ToggleRow icons ─── */
function IconHaptic() {
  const accent = useAccent();
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Path d="M8 6.5C6.2 7.8 5 9.8 5 12s1.2 4.2 3 5.5" stroke={C.white} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d="M16 6.5c1.8 1.3 3 3.3 3 5.5s-1.2 4.2-3 5.5" stroke={C.white} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Circle cx={12} cy={12} r={2} stroke={C.white} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}
function IconBell() {
  const accent = useAccent();
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" stroke={C.white} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d="M13.73 21a2 2 0 0 1-3.46 0" stroke={C.white} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}
function IconAlert() {
  const accent = useAccent();
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={4} stroke={C.white} strokeWidth={2} fill="none" />
      <Path d="M12 1v3M12 20v3M4 12H1M23 12h-3M5.6 5.6 7.7 7.7M16.3 16.3l2.1 2.1M5.6 18.4 7.7 16.3M16.3 7.7l2.1-2.1" stroke={C.white} strokeWidth={2} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

/* ─── Hub flat illustrations ─── */
function IlluDetails() {
  const accent = useAccent();
  return (
    <Svg width={80} height={72} viewBox="0 0 80 72">
      <Circle cx={32} cy={18} r={10} fill="#C8C8CC" />
      <Path d="M22 16 Q22 8 32 7 Q42 8 42 16 L42 13 Q39 5 32 5 Q25 5 22 13Z" fill="#2E2E30" />
      <Rect x={23} y={27} width={18} height={20} rx={6} fill={accent.solid} />
      <Rect x={14} y={28} width={10} height={6} rx={3} fill={accent.solid} />
      <Rect x={41} y={28} width={10} height={6} rx={3} fill={accent.solid} />
      <Rect x={25} y={45} width={6} height={14} rx={3} fill="#242425" />
      <Rect x={33} y={45} width={6} height={14} rx={3} fill="#242425" />
      <Rect x={46} y={22} width={28} height={20} rx={4} fill="#1F1F20" stroke={accent.solid} strokeWidth={1.2} />
      <Rect x={46} y={22} width={28} height={6} rx={3} fill={accent.solid} fillOpacity={0.35} />
      <Circle cx={53} cy={35} r={3.5} fill={accent.solid} fillOpacity={0.6} />
      <Rect x={58} y={33} width={10} height={1.5} rx={0.75} fill={accent.solid} fillOpacity={0.5} />
      <Rect x={58} y={36.5} width={7} height={1.5} rx={0.75} fill={accent.solid} fillOpacity={0.3} />
      <Circle cx={28} cy={17} r={1.2} fill="#2E2E30" />
      <Circle cx={36} cy={17} r={1.2} fill="#2E2E30" />
      <Path d="M28 22 Q32 25 36 22" stroke="#2E2E30" strokeWidth={1.2} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

function IlluSettings() {
  const accent = useAccent();
  return (
    <Svg width={80} height={72} viewBox="0 0 80 72">
      <Rect x={4} y={56} width={72} height={5} rx={2.5} fill="#242425" />
      <Rect x={14} y={46} width={48} height={10} rx={2} fill="#242425" />
      <Rect x={16} y={18} width={44} height={30} rx={3} fill="#1F1F20" stroke={accent.solid} strokeWidth={1} strokeOpacity={0.4} />
      <Rect x={21} y={26} width={22} height={2.5} rx={1.25} fill="#2E2E30" />
      <Rect x={21} y={26} width={13} height={2.5} rx={1.25} fill={accent.solid} fillOpacity={0.7} />
      <Circle cx={34} cy={27.25} r={3} fill={accent.solid} />
      <Rect x={21} y={33} width={22} height={2.5} rx={1.25} fill="#2E2E30" />
      <Rect x={21} y={33} width={16} height={2.5} rx={1.25} fill={accent.solid} fillOpacity={0.5} />
      <Circle cx={37} cy={34.25} r={3} fill={accent.solid} fillOpacity={0.8} />
      <Rect x={21} y={40} width={22} height={2.5} rx={1.25} fill="#2E2E30" />
      <Rect x={21} y={40} width={8} height={2.5} rx={1.25} fill={accent.solid} fillOpacity={0.4} />
      <Circle cx={29} cy={41.25} r={3} fill={accent.solid} fillOpacity={0.6} />
      <Circle cx={64} cy={34} r={9} fill="#C8C8CC" />
      <Path d="M55 32 Q55 25 64 24 Q73 25 73 32 L73 29 Q70 22 64 22 Q58 22 55 29Z" fill="#2E2E30" />
      <Path d="M56 42 Q56 39 64 39 Q72 39 72 42 L74 56 L54 56Z" fill={accent.solid} fillOpacity={0.7} />
      <Circle cx={60} cy={33} r={1.2} fill="#2E2E30" />
      <Circle cx={68} cy={33} r={1.2} fill="#2E2E30" />
      <Path d="M60 38 Q64 41 68 38" stroke="#2E2E30" strokeWidth={1.2} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

function IlluSupport() {
  const accent = useAccent();
  return (
    <Svg width={80} height={72} viewBox="0 0 80 72">
      <Circle cx={34} cy={22} r={11} fill="#C8C8CC" />
      <Path d="M23 20 Q23 11 34 10 Q45 11 45 20 L45 16 Q42 8 34 8 Q26 8 23 16Z" fill="#242425" />
      <Path d="M23 19 Q23 10 34 10 Q45 10 45 19" stroke={accent.solid} strokeWidth={2.5} fill="none" strokeLinecap="round" />
      <Rect x={20} y={18} width={6} height={8} rx={2.5} fill={accent.solid} />
      <Rect x={42} y={18} width={6} height={8} rx={2.5} fill={accent.solid} />
      <Path d="M23 24 Q17 28 16 33" stroke={accent.solid} strokeWidth={2} strokeLinecap="round" fill="none" />
      <Circle cx={15} cy={35} r={2.5} fill={accent.solid} />
      <Rect x={25} y={31} width={18} height={20} rx={6} fill={accent.solid} fillOpacity={0.8} />
      <Rect x={15} y={32} width={11} height={6} rx={3} fill={accent.solid} fillOpacity={0.8} />
      <Rect x={27} y={49} width={6} height={14} rx={3} fill="#242425" />
      <Rect x={35} y={49} width={6} height={14} rx={3} fill="#242425" />
      <Circle cx={29} cy={21} r={1.2} fill="#2E2E30" />
      <Circle cx={39} cy={21} r={1.2} fill="#2E2E30" />
      <Path d="M29 26 Q34 29 39 26" stroke="#2E2E30" strokeWidth={1.2} strokeLinecap="round" fill="none" />
      <Rect x={50} y={6} width={26} height={20} rx={6} fill="#1F1F20" stroke={accent.solid} strokeWidth={1} />
      <Path d="M54 26 L51 32 L60 26" fill="#1F1F20" stroke={accent.solid} strokeWidth={1} />
      <Circle cx={58} cy={16} r={2} fill={accent.solid} fillOpacity={0.8} />
      <Circle cx={63} cy={16} r={2} fill={accent.solid} fillOpacity={0.8} />
      <Circle cx={68} cy={16} r={2} fill={accent.solid} fillOpacity={0.8} />
    </Svg>
  );
}

/* ─────────────────────── STYLES ─────────────────────── */
const styles = scaledStyles({
  safe: { flex: 1, backgroundColor: C.bg },

  eyebrow: {
    fontSize: 11,
    fontWeight: "600",
    color: C.g3,
    letterSpacing: 0.88,
    marginBottom: 6,
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
    paddingBottom: 18,
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
  statCol: { flex: 1, paddingVertical: 10, alignItems: "center" },
  statColDivider: { borderRightWidth: 1, borderRightColor: C.border },
  statVal: { fontSize: 13, fontWeight: "700", color: C.white },
  statLbl: { fontSize: 10, color: C.g3, marginTop: 2, letterSpacing: 0.3 },

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
  sectionCardIllu: { position: "absolute", top: 4, right: 4, opacity: 0.92 },
  sectionCardTextWrap: { maxWidth: "58%", zIndex: 1 },
  sectionCardTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: C.white,
    letterSpacing: -0.5,
    lineHeight: 23,
  },
  sectionCardDesc: { fontSize: 12, color: C.g2, marginTop: 5, lineHeight: 17 },

  /* — divider, sign-out, version — */
  divider: { height: 1, backgroundColor: C.border, marginHorizontal: GUTTER, marginTop: 16 },
  stack: { flex: 1 },
  layer: { ...StyleSheet.absoluteFillObject },
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
    paddingVertical: 14,
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
    paddingVertical: 14,
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
  backHeaderBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: C.s2,
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
    paddingTop: 18,
    paddingBottom: 8,
  },
  stripeLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: GUTTER,
    paddingTop: 20,
    paddingBottom: 8,
  },
  stripeBar: { width: 3, height: 14, borderRadius: 9999, backgroundColor: C.green },
  stripeLabelText: {
    fontSize: 11,
    fontWeight: "600",
    color: C.g3,
    letterSpacing: 0.88,
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
    gap: 13,
    paddingHorizontal: 16,
    paddingVertical: 13,
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
  rowSub: { fontSize: 12, color: C.g2, marginTop: 2 },
  rowValue: { fontSize: 14, color: C.g2 },

  /* — theme cards — */
  themeRow: { flexDirection: "row", paddingHorizontal: 16, gap: 10 },
  // Two-Layer-Card: Outer-Ring wird beim Active mit accent-solid eingefärbt
  // (4px Padding) und Inner-Card hat eigenen Border der dann transparent
  // wird damit der Outer-Ring durchscheint. Look matched die Designvorlage
  // (Lime-Glow um die ausgewählte Card).
  themeCardOuter: { flex: 1, borderRadius: 18, padding: 4 },
  themeCardInner: { borderRadius: 14, overflow: "hidden", borderWidth: 1 },
  themeFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: SPACE.md, paddingVertical: 10 },
  themeFooterText: { fontSize: 14, fontWeight: "700" },
  // Color-Swatch im Color-Picker: 54px hoher Gradient-Block mit Check-Badge.
  colorSwatch: { height: 54, alignItems: "center", justifyContent: "center" },
  colorCheck: { width: 26, height: 26, borderRadius: 13, backgroundColor: "rgba(0,0,0,0.82)", alignItems: "center", justifyContent: "center" },
  // Language-Badge: 44×44, rounded 13, code-Text 13pt 800 — replaces den
  // alten rowIcon-Look damit die Settings konsistent zur Design-Vorlage sind.
  langBadge: { width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  langBadgeText: { fontSize: 13, fontWeight: "800" },
  themeCard: { flex: 1, borderRadius: 16, borderWidth: 2, overflow: "hidden" },
  themePreview: {
    height: 72,
    paddingHorizontal: 8,
    paddingTop: 10,
    paddingBottom: 8,
  },
  themePreviewBar: { width: "60%", height: 5, borderRadius: 3, marginBottom: 6 },
  themePreviewBlock: { width: "90%", height: 24, borderRadius: 6 },
  themeLabelRow: {
    backgroundColor: C.s1,
    paddingHorizontal: SPACE.sm,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  themeLabel: { fontSize: 12, fontWeight: "600" },

  /* — language flag inside the row icon container — */
  langFlagText: { fontSize: 11, fontWeight: "700" },

  /* — currency pills — */
  currencyRow: { paddingHorizontal: 16, gap: 8 },
  currencyPill: {
    paddingHorizontal: SPACE.lg,
    paddingVertical: 10,
    borderRadius: 9999,
    borderWidth: 1.5,
  },
  currencyPillText: { fontSize: 13 },

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

  /* — saved-toast position segment — */
  toastDesc: { fontSize: 12, color: C.g2, lineHeight: 17, marginBottom: 10, paddingHorizontal: 4 },
  toastSegment: {
    flexDirection: "row",
    backgroundColor: C.s1,
    borderRadius: 14,
    padding: 4,
    gap: 4,
  },
  toastSegmentItem: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  toastSegmentText: { fontSize: 13, letterSpacing: -0.1 },

  /* — FAQ — */
  faqRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  faqQ: { flex: 1, fontSize: 14, fontWeight: "500", color: C.white, paddingRight: 12 },
  faqA: { paddingHorizontal: 16, paddingBottom: 14, fontSize: 13, color: C.g2, lineHeight: 19 },
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
 * Der Bildschirm „Einstellungen" ist mehrere Bildschirme hoch: drei Themen-
 * Karten mit eigener Vorschau-Oberfläche, die Farbreihe, vier Sprachen, sechs
 * Währungen, dazu die Schalter. Das sind ein paar hundert Ansichten, und Fabric
 * baut sie auf DEMSELBEN Strang auf, auf dem die Bewegung läuft. Sie lief also
 * gegen den Aufbau an.
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
        settingsPush.value = withTiming(1, PUSH_SPRING, (finished?: boolean) => {
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
      settingsPush.value = withTiming(0, POP_SPRING, (finished?: boolean) => {
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
      back();
      return true; // verbraucht — sonst schlösse Android die App.
    });
    return () => h.remove();
  }, [sub, back]);

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
          {display === "settings" && <SettingsSubScreen onBack={back} />}
          {display === "support" && <SupportSubScreen onBack={back} />}
        </SubSettledContext.Provider>
      </Animated.ScrollView>
    </Animated.View>
  );
}
