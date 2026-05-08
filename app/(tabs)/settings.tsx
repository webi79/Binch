import { ReactNode, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Linking,
  Image,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
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
  Pencil,
} from "lucide-react-native";
import { useSearchStore, Locale } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { authLogout, authUpdateAvatar } from "@/lib/api/client";
import { showAlert } from "@/lib/alert";
import { RippleTouch } from "@/components/ui/RippleTouch";

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
  const [sub, setSub] = useState<SubScreen>(null);

  const back = () => {
    haptic("button");
    setSub(null);
  };
  const navTo = (id: Exclude<SubScreen, null>) => {
    haptic("button");
    setSub(id);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 90 }}
        showsVerticalScrollIndicator={false}
      >
        {sub === null && <Hub onNav={navTo} />}
        {sub === "details" && <DetailsScreen onBack={back} />}
        {sub === "settings" && <SettingsSubScreen onBack={back} />}
        {sub === "support" && <SupportSubScreen onBack={back} />}
      </ScrollView>
    </SafeAreaView>
  );
}

/* ─────────────────────── HUB ─────────────────────── */
function Hub({ onNav }: { onNav: (id: Exclude<SubScreen, null>) => void }) {
  const t = useT();
  const isAuthed = useSearchStore((s) => s.authUser !== null);
  const token = useSearchStore((s) => s.authToken);
  const clearAuth = useSearchStore((s) => s.clearAuth);

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

      <View style={{ paddingHorizontal: 16 }}>
        {tiles.map((tile, idx) => (
          <View key={tile.id} style={{ marginBottom: idx < tiles.length - 1 ? 8 : 0 }}>
            <SectionCard
              title={t(tile.titleKey)}
              desc={t(tile.descKey)}
              illu={tile.illu}
              onPress={() => onNav(tile.id)}
            />
          </View>
        ))}
      </View>

      {isAuthed ? (
        <>
          <View style={styles.divider} />
          <RippleTouch
            onPress={onSignOut}
            style={({ pressed }) => [styles.signOut, pressed && { opacity: 0.7 }]}
          >
            <LogOut size={18} color={C.red} strokeWidth={2} />
            <Text style={styles.signOutText}>{t("settings.signout")}</Text>
          </RippleTouch>
        </>
      ) : null}

      <Text style={styles.versionText}>{t("settings.app.version")}</Text>
    </View>
  );
}

function ProfileCard() {
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
    <View style={styles.profileCard}>
      <View style={styles.profileTopRow}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={styles.eyebrow}>{t("settings.account").toUpperCase()}</Text>
          {isAuthed ? (
            <>
              <Text style={styles.profileName}>
                {user.firstName}
                {"\n"}
                {user.lastName}
              </Text>
              <Text style={styles.profileEmail}>{user.email}</Text>
            </>
          ) : (
            <>
              <Text style={styles.profileName}>{t("auth.guest.title")}</Text>
              <Pressable onPress={onAvatarPress} hitSlop={6}>
                <Text style={styles.profileGuestCta}>{t("auth.guest.cta")}</Text>
              </Pressable>
            </>
          )}
        </View>
        <Pressable onPress={onAvatarPress} disabled={isAuthed} style={styles.avatarWrap}>
          {isAuthed ? (
            <LinearGradient
              colors={[C.green, C.greenDark]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.avatar}
            >
              <Text style={styles.avatarText}>{initials}</Text>
            </LinearGradient>
          ) : (
            <View style={[styles.avatar, { backgroundColor: C.s2, borderWidth: 1, borderColor: C.border }]}>
              <User size={26} color={C.g2} strokeWidth={2} />
            </View>
          )}
          <View pointerEvents="none" style={styles.avatarRing} />
          {isAuthed ? <View style={styles.avatarStatusDot} /> : null}
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

function Stat({ val, label, accent, withDivider }: { val: string; label: string; accent?: boolean; withDivider?: boolean }) {
  return (
    <View style={[styles.statCol, withDivider && styles.statColDivider]}>
      <Text style={[styles.statVal, accent && { color: C.green }]}>{val}</Text>
      <Text style={styles.statLbl}>{label}</Text>
    </View>
  );
}

function SectionCard({
  title,
  desc,
  illu,
  onPress,
}: {
  title: string;
  desc: string;
  illu: ReactNode;
  onPress: () => void;
}) {
  return (
    <RippleTouch
      onPress={onPress}
      style={({ pressed }) => [
        styles.sectionCard,
        pressed && { backgroundColor: C.s3, transform: [{ scale: 0.982 }] },
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
            <LinearGradient
              colors={[C.green, C.greenDark]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.avatarLarge}
            >
              <Text style={styles.avatarLargeText}>{initials}</Text>
            </LinearGradient>
          ) : (
            <View style={[styles.avatarLarge, { backgroundColor: C.s2, borderWidth: 1, borderColor: C.border }]}>
              <User size={36} color={C.g2} strokeWidth={2} />
            </View>
          )}
          {user ? (
            <View style={styles.avatarEditDot}>
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
              <Text style={styles.editPhotoText}>{t("settings.detail.editphoto")}</Text>
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
            <Text style={styles.editPhotoText}>{t("auth.guest.cta")}</Text>
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
    </View>
  );
}

/* ─────────────────────── SETTINGS SUB ─────────────────────── */
const THEMES: { id: "dark" | "light" | "gray"; bg: string; surface: string }[] = [
  { id: "dark", bg: "#1A1A1A", surface: "#1F1F20" },
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
  const t = useT();
  const theme = useSearchStore((s) => s.theme);
  const setTheme = useSearchStore((s) => s.setTheme);
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

      {/* APPEARANCE */}
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
              style={[styles.themeCard, { borderColor: active ? C.green : C.border }]}
            >
              <View style={[styles.themePreview, { backgroundColor: th.bg }]}>
                <View style={[styles.themePreviewBar, { backgroundColor: th.surface }]} />
                <View style={[styles.themePreviewBlock, { backgroundColor: th.surface }]} />
              </View>
              <View style={styles.themeLabelRow}>
                <Text style={[styles.themeLabel, { color: active ? C.green : C.g1 }]}>
                  {t(`theme.label.${th.id}`)}
                </Text>
                {active && <Check size={14} color={C.green} strokeWidth={2.5} />}
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* LANGUAGE */}
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
                active && { backgroundColor: "rgba(127,234,77,0.04)" },
              ]}
            >
              <View style={[styles.rowIcon, { backgroundColor: C.s2 }]}>
                <Text style={[styles.langFlagText, { color: active ? C.green : C.g2 }]}>
                  {l.flag}
                </Text>
              </View>
              <Text
                style={[
                  styles.rowLabel,
                  {
                    flex: 1,
                    color: active ? C.white : C.g1,
                    fontWeight: active ? "600" : "400",
                  },
                ]}
              >
                {l.label}
              </Text>
              {active && <Check size={16} color={C.green} strokeWidth={2.5} />}
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
                  backgroundColor: active ? C.green : C.s1,
                  borderColor: active ? C.green : C.border,
                },
              ]}
            >
              <Text
                style={[
                  styles.currencyPillText,
                  { color: active ? "#000" : C.g2, fontWeight: active ? "700" : "500" },
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
      <View style={{ paddingHorizontal: 16 }}>
        <Text style={styles.toastDesc}>{t("settings.toast.desc")}</Text>
        <View style={styles.toastSegment}>
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
                  active && { backgroundColor: C.green },
                ]}
              >
                <Text
                  style={[
                    styles.toastSegmentText,
                    { color: active ? "#000" : C.g1, fontWeight: active ? "700" : "500" },
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
    </View>
  );
}

/* ─────────────────────── SUPPORT ─────────────────────── */
function SupportSubScreen({ onBack }: { onBack: () => void }) {
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

      <SLabel text={t("settings.support.faq")} />
      <View style={styles.group}>
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
    </View>
  );
}

/* ─────────────────────── SHARED ─────────────────────── */
function BackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.backHeader}>
      <Text style={styles.backHeaderTitle}>{title}</Text>
      <RippleTouch
        onPress={onBack}
        borderless
        style={({ pressed }) => [styles.backHeaderBtn, pressed && { opacity: 0.7 }]}
      >
        <X size={16} color={C.white} strokeWidth={2.5} />
      </RippleTouch>
    </View>
  );
}

function SLabel({ text }: { text: string }) {
  return <Text style={styles.sLabel}>{text.toUpperCase()}</Text>;
}

function StripeLabel({ text, firstSection }: { text: string; firstSection?: boolean }) {
  return (
    <View style={[styles.stripeLabel, firstSection && { paddingTop: 16 }]}>
      <View style={styles.stripeBar} />
      <Text style={styles.stripeLabelText}>{text.toUpperCase()}</Text>
    </View>
  );
}

function Group({ children }: { children: ReactNode }) {
  return <View style={styles.group}>{children}</View>;
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
  return (
    <View style={[styles.row, !isLast && styles.rowDivider]}>
      <View style={[styles.rowIcon, { backgroundColor: C.s2 }]}>{icon}</View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, { fontWeight: "500" }]}>{label}</Text>
        {desc ? <Text style={styles.rowSub}>{desc}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: C.s3, true: C.green }}
        thumbColor="#FFFFFF"
        ios_backgroundColor={C.s3}
      />
    </View>
  );
}

/* ─── ToggleRow icons ─── */
function IconHaptic() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Path d="M8 6.5C6.2 7.8 5 9.8 5 12s1.2 4.2 3 5.5" stroke={C.white} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d="M16 6.5c1.8 1.3 3 3.3 3 5.5s-1.2 4.2-3 5.5" stroke={C.white} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Circle cx={12} cy={12} r={2} stroke={C.white} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}
function IconBell() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" stroke={C.white} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d="M13.73 21a2 2 0 0 1-3.46 0" stroke={C.white} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}
function IconAlert() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={4} stroke={C.white} strokeWidth={2} fill="none" />
      <Path d="M12 1v3M12 20v3M4 12H1M23 12h-3M5.6 5.6 7.7 7.7M16.3 16.3l2.1 2.1M5.6 18.4 7.7 16.3M16.3 7.7l2.1-2.1" stroke={C.white} strokeWidth={2} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

/* ─── Hub flat illustrations ─── */
function IlluDetails() {
  return (
    <Svg width={80} height={72} viewBox="0 0 80 72">
      <Circle cx={32} cy={18} r={10} fill="#C8C8CC" />
      <Path d="M22 16 Q22 8 32 7 Q42 8 42 16 L42 13 Q39 5 32 5 Q25 5 22 13Z" fill="#2E2E30" />
      <Rect x={23} y={27} width={18} height={20} rx={6} fill={C.green} />
      <Rect x={14} y={28} width={10} height={6} rx={3} fill={C.green} />
      <Rect x={41} y={28} width={10} height={6} rx={3} fill={C.green} />
      <Rect x={25} y={45} width={6} height={14} rx={3} fill="#242425" />
      <Rect x={33} y={45} width={6} height={14} rx={3} fill="#242425" />
      <Rect x={46} y={22} width={28} height={20} rx={4} fill="#1F1F20" stroke={C.green} strokeWidth={1.2} />
      <Rect x={46} y={22} width={28} height={6} rx={3} fill={C.green} fillOpacity={0.35} />
      <Circle cx={53} cy={35} r={3.5} fill={C.green} fillOpacity={0.6} />
      <Rect x={58} y={33} width={10} height={1.5} rx={0.75} fill={C.green} fillOpacity={0.5} />
      <Rect x={58} y={36.5} width={7} height={1.5} rx={0.75} fill={C.green} fillOpacity={0.3} />
      <Circle cx={28} cy={17} r={1.2} fill="#2E2E30" />
      <Circle cx={36} cy={17} r={1.2} fill="#2E2E30" />
      <Path d="M28 22 Q32 25 36 22" stroke="#2E2E30" strokeWidth={1.2} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

function IlluSettings() {
  return (
    <Svg width={80} height={72} viewBox="0 0 80 72">
      <Rect x={4} y={56} width={72} height={5} rx={2.5} fill="#242425" />
      <Rect x={14} y={46} width={48} height={10} rx={2} fill="#242425" />
      <Rect x={16} y={18} width={44} height={30} rx={3} fill="#1F1F20" stroke={C.green} strokeWidth={1} strokeOpacity={0.4} />
      <Rect x={21} y={26} width={22} height={2.5} rx={1.25} fill="#2E2E30" />
      <Rect x={21} y={26} width={13} height={2.5} rx={1.25} fill={C.green} fillOpacity={0.7} />
      <Circle cx={34} cy={27.25} r={3} fill={C.green} />
      <Rect x={21} y={33} width={22} height={2.5} rx={1.25} fill="#2E2E30" />
      <Rect x={21} y={33} width={16} height={2.5} rx={1.25} fill={C.green} fillOpacity={0.5} />
      <Circle cx={37} cy={34.25} r={3} fill={C.green} fillOpacity={0.8} />
      <Rect x={21} y={40} width={22} height={2.5} rx={1.25} fill="#2E2E30" />
      <Rect x={21} y={40} width={8} height={2.5} rx={1.25} fill={C.green} fillOpacity={0.4} />
      <Circle cx={29} cy={41.25} r={3} fill={C.green} fillOpacity={0.6} />
      <Circle cx={64} cy={34} r={9} fill="#C8C8CC" />
      <Path d="M55 32 Q55 25 64 24 Q73 25 73 32 L73 29 Q70 22 64 22 Q58 22 55 29Z" fill="#2E2E30" />
      <Path d="M56 42 Q56 39 64 39 Q72 39 72 42 L74 56 L54 56Z" fill={C.green} fillOpacity={0.7} />
      <Circle cx={60} cy={33} r={1.2} fill="#2E2E30" />
      <Circle cx={68} cy={33} r={1.2} fill="#2E2E30" />
      <Path d="M60 38 Q64 41 68 38" stroke="#2E2E30" strokeWidth={1.2} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

function IlluSupport() {
  return (
    <Svg width={80} height={72} viewBox="0 0 80 72">
      <Circle cx={34} cy={22} r={11} fill="#C8C8CC" />
      <Path d="M23 20 Q23 11 34 10 Q45 11 45 20 L45 16 Q42 8 34 8 Q26 8 23 16Z" fill="#242425" />
      <Path d="M23 19 Q23 10 34 10 Q45 10 45 19" stroke={C.green} strokeWidth={2.5} fill="none" strokeLinecap="round" />
      <Rect x={20} y={18} width={6} height={8} rx={2.5} fill={C.green} />
      <Rect x={42} y={18} width={6} height={8} rx={2.5} fill={C.green} />
      <Path d="M23 24 Q17 28 16 33" stroke={C.green} strokeWidth={2} strokeLinecap="round" fill="none" />
      <Circle cx={15} cy={35} r={2.5} fill={C.green} />
      <Rect x={25} y={31} width={18} height={20} rx={6} fill={C.green} fillOpacity={0.8} />
      <Rect x={15} y={32} width={11} height={6} rx={3} fill={C.green} fillOpacity={0.8} />
      <Rect x={27} y={49} width={6} height={14} rx={3} fill="#242425" />
      <Rect x={35} y={49} width={6} height={14} rx={3} fill="#242425" />
      <Circle cx={29} cy={21} r={1.2} fill="#2E2E30" />
      <Circle cx={39} cy={21} r={1.2} fill="#2E2E30" />
      <Path d="M29 26 Q34 29 39 26" stroke="#2E2E30" strokeWidth={1.2} strokeLinecap="round" fill="none" />
      <Rect x={50} y={6} width={26} height={20} rx={6} fill="#1F1F20" stroke={C.green} strokeWidth={1} />
      <Path d="M54 26 L51 32 L60 26" fill="#1F1F20" stroke={C.green} strokeWidth={1} />
      <Circle cx={58} cy={16} r={2} fill={C.green} fillOpacity={0.8} />
      <Circle cx={63} cy={16} r={2} fill={C.green} fillOpacity={0.8} />
      <Circle cx={68} cy={16} r={2} fill={C.green} fillOpacity={0.8} />
    </Svg>
  );
}

/* ─────────────────────── STYLES ─────────────────────── */
const styles = StyleSheet.create({
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
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: C.s1,
    borderRadius: 22,
    overflow: "hidden",
  },
  profileTopRow: {
    paddingHorizontal: 18,
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
  profileGuestCta: {
    fontSize: 13,
    color: C.green,
    fontWeight: "700",
    marginTop: 8,
    textDecorationLine: "underline",
  },

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
    paddingHorizontal: 18,
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
  divider: { height: 1, backgroundColor: C.border, marginHorizontal: 16, marginTop: 16 },
  signOut: {
    marginHorizontal: 16,
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
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
  },
  backHeaderTitle: { fontSize: 17, fontWeight: "600", color: C.white },
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
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 8,
  },
  stripeLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
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
    marginHorizontal: 16,
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
    paddingHorizontal: 10,
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
    paddingHorizontal: 18,
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
