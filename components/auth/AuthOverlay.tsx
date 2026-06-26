import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  SlideInDown,
  SlideOutDown,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { authLogin, authRegister } from "@/lib/api/client";
import { GradientFill } from "@/components/ui/GradientFill";
import { useAccent } from "@/lib/theme/accent";

const C = {
  sheet: "#1F1F20",
  field: "#242425",
  border: "#2E2E30",
  text: "#FFFFFF",
  sub: "#8A8A90",
  subDim: "#56565C",
  lime: "#7FEA4D",
  black: "#000000",
  red: "#FF3B5C",
};

type Mode = "login" | "register";

export function AuthOverlay() {
  const open = useSearchStore((s) => s.authOverlayOpen);
  if (!open) return null;
  return <AuthSheet />;
}

function AuthSheet() {
  const close = useSearchStore((s) => s.closeAuthOverlay);
  const setAuth = useSearchStore((s) => s.setAuth);
  const t = useT();
  const accent = useAccent();
  const { height } = useWindowDimensions();

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [close]);

  const translateY = useSharedValue(0);
  const keyboardOffset = useSharedValue(0);
  const sheetAnim = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value + keyboardOffset.value }],
  }));

  // iOS fires keyboardWill*; on Android we settle for keyboardDid*. Some
  // Android keyboards briefly hide+show when switching between fields, so
  // we debounce the hide step to keep the sheet in place across switches.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const isIOS = Platform.OS === "ios";
    const showEvent = isIOS ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = isIOS ? "keyboardWillHide" : "keyboardDidHide";
    const SHOW_DURATION = isIOS ? 250 : 220;
    const HIDE_DURATION = isIOS ? 240 : 200;
    const HIDE_DEBOUNCE_MS = 90;

    const showSub = Keyboard.addListener(showEvent, (e) => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      const h = e.endCoordinates?.height ?? 0;
      cancelAnimation(keyboardOffset);
      keyboardOffset.value = withTiming(-h, {
        duration: SHOW_DURATION,
        easing: Easing.out(Easing.cubic),
      });
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => {
        cancelAnimation(keyboardOffset);
        keyboardOffset.value = withTiming(0, {
          duration: HIDE_DURATION,
          easing: Easing.out(Easing.cubic),
        });
        hideTimer.current = null;
      }, HIDE_DEBOUNCE_MS);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [keyboardOffset]);

  const panGesture = Gesture.Pan()
    .activeOffsetY(8)
    .failOffsetY(-8)
    .onUpdate((e) => {
      translateY.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > 110 || e.velocityY > 700) {
        translateY.value = withTiming(height, { duration: 220 });
        runOnJS(close)();
      } else {
        translateY.value = withSpring(0, { damping: 22, stiffness: 220 });
      }
    });

  const submit = async () => {
    if (busy) return;
    setError(null);
    haptic("button");
    try {
      setBusy(true);
      if (mode === "register") {
        if (!firstName.trim() || !lastName.trim()) {
          setError(t("auth.error.namerequired"));
          return;
        }
        if (password.length < 8) {
          setError(t("auth.error.pwshort"));
          return;
        }
        const res = await authRegister({
          email: email.trim().toLowerCase(),
          password,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
        });
        setAuth(res.token, res.user);
      } else {
        const res = await authLogin({
          email: email.trim().toLowerCase(),
          password,
        });
        setAuth(res.token, res.user);
      }
      haptic("important");
    } catch (e) {
      setError((e as Error).message || t("auth.error.generic"));
    } finally {
      setBusy(false);
    }
  };

  const submitLabel = mode === "register" ? t("auth.cta.register") : t("auth.cta.login");
  const switchHint = mode === "register" ? t("auth.switch.hasaccount") : t("auth.switch.noaccount");
  const switchAction = mode === "register" ? t("auth.cta.login") : t("auth.cta.register");

  return (
    <View style={StyleSheet.absoluteFillObject}>
      <Animated.View
        entering={FadeIn.duration(220)}
        exiting={FadeOut.duration(180)}
        style={styles.backdrop}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={busy ? undefined : close} />
      </Animated.View>
      <Animated.View
        entering={SlideInDown.duration(350)}
        exiting={SlideOutDown.duration(300)}
        style={[styles.sheet, sheetAnim]}
      >
        <GestureDetector gesture={panGesture}>
          <View style={styles.handleWrap}>
            <View style={styles.handle} />
          </View>
        </GestureDetector>

        <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.body}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.title}>
              {mode === "register" ? t("auth.title.register") : t("auth.title.login")}
            </Text>
            <Text style={styles.subtitle}>
              {mode === "register" ? t("auth.subtitle.register") : t("auth.subtitle.login")}
            </Text>

            {mode === "register" ? (
              <View style={styles.row2}>
                <View style={styles.col}>
                  <Text style={styles.label}>{t("auth.field.firstname")}</Text>
                  <TextInput
                    value={firstName}
                    onChangeText={setFirstName}
                    autoCapitalize="words"
                    autoComplete="given-name"
                    style={styles.input}
                    placeholderTextColor={C.subDim}
                    placeholder={t("auth.placeholder.firstname")}
                    editable={!busy}
                  />
                </View>
                <View style={styles.col}>
                  <Text style={styles.label}>{t("auth.field.lastname")}</Text>
                  <TextInput
                    value={lastName}
                    onChangeText={setLastName}
                    autoCapitalize="words"
                    autoComplete="family-name"
                    style={styles.input}
                    placeholderTextColor={C.subDim}
                    placeholder={t("auth.placeholder.lastname")}
                    editable={!busy}
                  />
                </View>
              </View>
            ) : null}

            <Text style={styles.label}>{t("auth.field.email")}</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              keyboardType="email-address"
              style={styles.input}
              placeholderTextColor={C.subDim}
              placeholder="name@example.com"
              editable={!busy}
            />

            <Text style={styles.label}>{t("auth.field.password")}</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              secureTextEntry
              style={styles.input}
              placeholderTextColor={C.subDim}
              placeholder={mode === "register" ? t("auth.placeholder.pwnew") : "••••••••"}
              editable={!busy}
            />

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <Pressable
              onPress={submit}
              disabled={busy}
              style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.9 }]}
            >
              <GradientFill />
              {busy ? (
                <ActivityIndicator color={C.black} />
              ) : (
                <Text style={styles.primaryBtnText}>{submitLabel}</Text>
              )}
            </Pressable>

            <View style={styles.switchRow}>
              <Text style={styles.switchHint}>{switchHint} </Text>
              <Pressable
                onPress={() => {
                  haptic("button");
                  setError(null);
                  setMode(mode === "register" ? "login" : "register");
                }}
                hitSlop={6}
              >
                <Text style={[styles.switchAction, { color: accent.solid }]}>{switchAction}</Text>
              </Pressable>
            </View>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: C.sheet,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingBottom: 32,
  },
  handleWrap: { alignItems: "center", paddingTop: 12, paddingBottom: 14 },
  handle: { width: 40, height: 4, borderRadius: 9999, backgroundColor: "#FFFFFF" },

  body: { paddingHorizontal: 22, paddingBottom: 24 },
  title: {
    color: C.text,
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  subtitle: {
    color: C.sub,
    fontSize: 13,
    marginTop: 6,
    marginBottom: 18,
    lineHeight: 18,
  },
  row2: { flexDirection: "row", gap: 10 },
  col: { flex: 1 },
  label: {
    color: C.sub,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginTop: 8,
    marginBottom: 6,
  },
  input: {
    backgroundColor: C.field,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: C.text,
    fontSize: 15,
    borderWidth: 1,
    borderColor: C.border,
  },
  errorText: { color: C.red, fontSize: 13, fontWeight: "600", marginTop: 12 },
  primaryBtn: {
    height: 48,
    borderRadius: 9999,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    marginTop: 18,
  },
  primaryBtnText: { color: C.black, fontSize: 15, fontWeight: "800", letterSpacing: -0.2 },
  switchRow: { flexDirection: "row", justifyContent: "center", marginTop: 18 },
  switchHint: { color: C.sub, fontSize: 13 },
  switchAction: { color: C.lime, fontSize: 13, fontWeight: "700", textDecorationLine: "underline" },
});
