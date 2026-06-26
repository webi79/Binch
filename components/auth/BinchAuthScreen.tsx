/**
 * BinchAuthScreen — E-Mail-zuerst Anmelde-/Registrier-Flow.
 *
 * Ersetzt das alte AuthOverlay (Tab-basierter Login/Register) durch einen
 * step-basierten Flow:
 *   1. E-Mail eingeben → Weiter
 *   2. Backend-Check ob das Konto existiert
 *        bekannt → Login-Pfad:       Passwort → Anmelden
 *        neu     → Registrier-Pfad:  Name → Passwort → Konto erstellen
 *   3. Erfolg → Bo fliegt rein, begrüßt den Nutzer, schließt sich.
 *
 * Adaptierung an Binch:
 *  - useAccent() für dynamischen Akzent (lime/mint) statt hartcoded Lime
 *  - useT() für i18n (de/en/fr/es)
 *  - Lucide-Icons + minimaler SVG für Apple/Google-Brand-Marks
 *  - Bo aus @/components/assistant (mit BoMood-Type)
 *  - Auth-API-Calls über authLogin / authRegister (existing)
 *
 * Email-Existenz-Check: Es gibt aktuell keinen /api/auth/check-email
 * Endpoint. Stattdessen: erst authLogin versuchen; bei „user not found"
 * → register-Pfad, bei „wrong password" → login-Pfad mit Passwort-Eingabe.
 * Bei beliebigem anderen Fehler oder neuem User Default = register-Pfad.
 */
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  SlideInDown,
  SlideInLeft,
  SlideInRight,
  SlideOutDown,
  interpolate,
  useAnimatedKeyboard,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  Eye,
  EyeOff,
  Lock,
  Mail,
  User,
} from "lucide-react-native";
import Svg, { Path as SvgPath } from "react-native-svg";
import { Bo, type BoMood } from "@/components/assistant/Bo";
import { authCheckEmail, authLogin, authRegister, type AuthResponse } from "@/lib/api/client";
import { GradientFill } from "@/components/ui/GradientFill";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useAccent } from "@/lib/theme/accent";
import { haptic } from "@/lib/haptics";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore } from "@/stores/searchStore";

const C = {
  bg: "#1A1A1A",
  surface2: "#242425",
  surface3: "#2A2A2C",
  surface4: "#323234",
  border: "#2E2E30",
  white: "#FFFFFF",
  textSecondary: "#C8C8CC",
  textTertiary: "#8A8A90",
  error: "#FF7A6B",
  goodOrange: "#FFC65C",
};

type Path = "login" | "register";
type Step = "email" | "name" | "password";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isEmail = (v: string) => EMAIL_RE.test(v.trim());

function rateStrength(v: string): number {
  let s = 0;
  if (v.length >= 6) s++;
  if (v.length >= 10) s++;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
  if (/\d/.test(v) || /[^A-Za-z0-9]/.test(v)) s++;
  return Math.min(s, 4);
}

export function BinchAuthScreen() {
  const open = useSearchStore((s) => s.authOverlayOpen);
  if (!open) return null;
  return <Sheet />;
}

function Sheet() {
  const t = useT();
  const accent = useAccent();
  const close = useSearchStore((s) => s.closeAuthOverlay);
  const setAuth = useSearchStore((s) => s.setAuth);

  const [path, setPath] = useState<Path>("login");
  const [step, setStep] = useState<Step>("email");
  const [dir, setDir] = useState<"fwd" | "back">("fwd");

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);

  const [errors, setErrors] = useState<{
    email?: boolean;
    name?: boolean;
    pass?: boolean;
  }>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<{ mode: Path; firstName: string } | null>(
    null,
  );

  const order: Step[] = path === "login" ? ["email", "password"] : ["email", "name", "password"];
  const total = step === "email" ? 2 : order.length;
  const idx = order.indexOf(step);

  // Sheet hebt sich beim Keyboard-Open frame-genau via useAnimatedKeyboard
  // an — paddingBottom = Keyboard-Höhe.
  const keyboard = useAnimatedKeyboard();
  const sheetStyle = useAnimatedStyle(() => ({
    paddingBottom: keyboard.height.value + 28,
  }));

  // Social-Section sofort ausblenden sobald irgendein Input fokussiert wird —
  // sonst sieht der User die Apple/Google-Buttons kurz nach oben fliegen
  // bevor der paddingBottom-Layout-Pass die Position korrigiert.
  // Wir tracken's via TextInput onFocus/onBlur (sicher auf beiden
  // Plattformen, fired noch vor keyboard.height-Updates).
  const [inputFocused, setInputFocused] = useState(false);

  // Progress bar
  const [trackW, setTrackW] = useState(0);
  const barW = useSharedValue(0);
  useEffect(() => {
    const frac = (idx + 1) / total;
    barW.value = withTiming(trackW * frac, {
      duration: 420,
      easing: Easing.out(Easing.cubic),
    });
  }, [idx, total, trackW, barW]);
  const barStyle = useAnimatedStyle(() => ({ width: barW.value }));

  function goTo(next: Step, direction: "fwd" | "back") {
    setDir(direction);
    setStep(next);
  }

  function back() {
    if (idx <= 0) return;
    const prev = order[idx - 1];
    if (prev) goTo(prev, "back");
  }

  function editEmail() {
    goTo("email", "back");
  }

  /** Backend-Check ob die Email registriert ist → entscheidet login/register-Pfad. */
  async function submitEmail() {
    const e = email.trim().toLowerCase();
    if (!isEmail(e)) {
      setErrors({ email: true });
      return;
    }
    setErrors({});
    setErrorMsg(null);
    setLoading(true);
    try {
      const { exists } = await authCheckEmail(e);
      const next: Path = exists ? "login" : "register";
      setPath(next);
      goTo(next === "login" ? "password" : "name", "fwd");
    } catch (err) {
      // Network/Server-Error: defaulten auf register-Pfad, User kann jedenfalls
      // weiter (bei Register mit existing email würde der Server eh 409 melden).
      setPath("register");
      goTo("name", "fwd");
    } finally {
      setLoading(false);
    }
  }

  function submitName() {
    if (name.trim().length < 2) {
      setErrors({ name: true });
      return;
    }
    setErrors({});
    goTo("password", "fwd");
  }

  async function submitPassword() {
    const min = path === "login" ? 1 : 6;
    if (password.length < min) {
      setErrors({ pass: true });
      return;
    }
    setErrors({});
    setErrorMsg(null);
    setLoading(true);
    try {
      let res: AuthResponse;
      if (path === "login") {
        res = await authLogin({ email: email.trim(), password });
      } else {
        // Name in firstName/lastName splitten — Backend erwartet beides.
        const parts = name.trim().split(/\s+/);
        const firstName = parts[0] ?? "";
        const lastName = parts.slice(1).join(" ") || firstName;
        res = await authRegister({
          email: email.trim(),
          password,
          firstName,
          lastName,
        });
      }
      setAuth(res.token, res.user);
      const firstName = (res.user.firstName ?? name.trim().split(" ")[0] ?? "").trim();
      setSuccess({ mode: path, firstName });
      haptic("important");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      const lower = msg.toLowerCase();
      // Wenn Register fehlschlägt weil die Email schon existiert (409 /
      // „already registered") → automatisch auf login-Pfad switchen und den
      // User um sein Passwort bitten. Häufig, wenn der check-email-Endpoint
      // noch nicht live ist und unser Fallback fälschlich auf register
      // gedefaulted hatte.
      if (
        path === "register" &&
        (lower.includes("409") ||
          lower.includes("already") ||
          lower.includes("registered"))
      ) {
        setPath("login");
        setPassword("");
        setErrors({});
        setErrorMsg(null);
        goTo("password", "back");
      } else {
        setErrorMsg(msg || t("auth.error.generic"));
        setErrors({ pass: true });
      }
    } finally {
      setLoading(false);
    }
  }

  function primaryAction() {
    haptic("button");
    if (step === "email") return submitEmail();
    if (step === "name") return submitName();
    return submitPassword();
  }

  const canSubmit =
    step === "email"
      ? isEmail(email)
      : step === "name"
        ? name.trim().length >= 2
        : path === "login"
          ? password.length >= 1
          : password.length >= 6;

  const primaryLabel =
    step === "password"
      ? path === "login"
        ? t("binchauth.cta.login")
        : t("binchauth.cta.register")
      : t("binchauth.cta.continue");

  const score = rateStrength(password);
  const strengthLabels = [
    t("binchauth.strength.short"),
    t("binchauth.strength.weak"),
    t("binchauth.strength.ok"),
    t("binchauth.strength.good"),
    t("binchauth.strength.strong"),
  ];
  const strengthColors = [
    C.surface4,
    C.error,
    C.goodOrange,
    accent.dark as string,
    accent.solid as string,
  ];

  const slideIn = dir === "back" ? SlideInLeft : SlideInRight;

  return (
    <Animated.View
      entering={SlideInDown.duration(350)}
      exiting={SlideOutDown.duration(300)}
      style={styles.root}
    >
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/* Brand-Band */}
      <View style={styles.band}>
        <LinearGradient
          colors={["#f7b15c", "#e8784e", "#7a4a6e", "#2c3a63"]}
          locations={[0, 0.3, 0.64, 1]}
          start={{ x: 0.3, y: 0 }}
          end={{ x: 0.7, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.sun} />
        <View style={[styles.hill, styles.hill2]} />
        <View style={[styles.hill, styles.hill1]} />
        <LinearGradient
          colors={["transparent", "rgba(26,26,26,0.35)", C.bg]}
          locations={[0.4, 0.8, 1]}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.bandRow}>
          <Text style={styles.brand}>
            B<Text style={{ color: accent.solid }}>i</Text>nch
          </Text>
          {/* Runder Back-Button — gleicher Stil wie der RouteBanner-Back
              auf der Map: 44×44, dunkles Surface, ArrowLeft Icon. Schließt
              den Auth-Screen komplett. */}
          <RippleTouch
            onPress={close}
            hitSlop={6}
            style={styles.closeBtn}
            accessibilityLabel="Schließen"
            borderless
          >
            <ArrowLeft color={C.white} size={20} strokeWidth={2.2} />
          </RippleTouch>
        </View>
      </View>

      {/* Sheet — paddingBottom dynamisch = Keyboard-Höhe + 28 */}
      <Animated.View style={[styles.sheet, sheetStyle]}>
        {/* nav: back + progress */}
        <View style={styles.navRow}>
          {idx > 0 ? (
            <Pressable onPress={back} style={styles.backBtn} hitSlop={10}>
              <ChevronLeft size={19} color={C.white} strokeWidth={2.4} />
            </Pressable>
          ) : (
            <View style={styles.backSpacer} />
          )}
          <View
            style={styles.track}
            onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
          >
            <Animated.View
              style={[styles.bar, { backgroundColor: accent.solid }, barStyle]}
            />
          </View>
          <Text style={styles.counter}>
            {idx + 1}/{total}
          </Text>
        </View>

        {/* steps + primary CTA — Continue/Sign-In sitzt DIREKT unter dem
            Input-Feld, nicht im Footer. Damit folgt nur er + die Input-
            Fields nach oben wenn das Keyboard aufgeht; Social-Section
            unten wird vom Keyboard überdeckt. */}
        <View style={styles.stepWrap}>
          <Animated.View key={step} entering={slideIn.duration(420)} style={styles.panel}>
            {step === "email" && (
              <>
                <Text style={styles.h1} numberOfLines={1} adjustsFontSizeToFit>
                  {t("binchauth.welcome.title")}
                </Text>
                <Text style={styles.sub}>{t("binchauth.welcome.sub")}</Text>
                <Field
                  label={t("binchauth.field.email")}
                  icon={<Mail size={19} color={C.textTertiary} />}
                  bad={errors.email}
                  errorText={t("binchauth.error.email")}
                >
                  <TextInput
                    style={styles.input}
                    value={email}
                    onChangeText={(v) => {
                      setEmail(v);
                      setErrors((e) => ({ ...e, email: false }));
                    }}
                    placeholder="du@beispiel.de"
                    placeholderTextColor={C.textTertiary}
                    // Standard-QWERTY-Tastatur (kein email-address-Layout).
                    // User hat im normalen Layout @ über Long-Press, kein
                    // versteckter "secure" Mode.
                    keyboardType="default"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="email"
                    // returnKey schließt nur das Keyboard — User bestätigt
                    // anschließend bewusst über den großen Continue-Button.
                    returnKeyType="done"
                    onSubmitEditing={() => Keyboard.dismiss()}
                    onFocus={() => setInputFocused(true)}
                    onBlur={() => setInputFocused(false)}
                  />
                </Field>
              </>
            )}

            {step === "name" && (
              <>
                <Text style={styles.h1} numberOfLines={1} adjustsFontSizeToFit>
                  {t("binchauth.name.title")}
                </Text>
                <Text style={styles.sub}>{t("binchauth.name.sub")}</Text>
                <EmailChip email={email} onEdit={editEmail} editLabel={t("binchauth.edit")} accent={accent.solid as string} />
                <Field
                  label={t("binchauth.field.name")}
                  icon={<User size={19} color={C.textTertiary} />}
                  bad={errors.name}
                  errorText={t("binchauth.error.name")}
                >
                  <TextInput
                    style={styles.input}
                    value={name}
                    onChangeText={(v) => {
                      setName(v);
                      setErrors((e) => ({ ...e, name: false }));
                    }}
                    placeholder={t("binchauth.placeholder.name")}
                    placeholderTextColor={C.textTertiary}
                    autoComplete="name"
                    returnKeyType="done"
                    onSubmitEditing={() => Keyboard.dismiss()}
                    onFocus={() => setInputFocused(true)}
                    onBlur={() => setInputFocused(false)}
                  />
                </Field>
              </>
            )}

            {step === "password" && (
              <>
                <Text style={styles.h1} numberOfLines={1} adjustsFontSizeToFit>
                  {path === "login"
                    ? t("binchauth.password.title.login")
                    : t("binchauth.password.title.register")}
                </Text>
                <Text style={styles.sub}>
                  {path === "login"
                    ? t("binchauth.password.sub.login")
                    : t("binchauth.password.sub.register")}
                </Text>
                <EmailChip email={email} onEdit={editEmail} editLabel={t("binchauth.edit")} accent={accent.solid as string} />
                <Field
                  label={
                    path === "login"
                      ? t("binchauth.field.password")
                      : t("binchauth.field.passwordnew")
                  }
                  icon={<Lock size={19} color={C.textTertiary} />}
                  bad={errors.pass}
                  errorText={errorMsg ?? t("binchauth.error.password")}
                  trailing={
                    <Pressable onPress={() => setShowPass((s) => !s)} hitSlop={8}>
                      {showPass ? (
                        <EyeOff size={20} color={C.textTertiary} />
                      ) : (
                        <Eye size={20} color={C.textTertiary} />
                      )}
                    </Pressable>
                  }
                >
                  <TextInput
                    style={styles.input}
                    value={password}
                    onChangeText={(v) => {
                      setPassword(v);
                      setErrors((e) => ({ ...e, pass: false }));
                      setErrorMsg(null);
                    }}
                    placeholder={
                      path === "login"
                        ? t("binchauth.placeholder.password")
                        : t("binchauth.placeholder.passwordnew")
                    }
                    placeholderTextColor={C.textTertiary}
                    // Standard-Tastatur. secureTextEntry hides die Eingabe
                    // (Dots) ohne dass Android in einen secure-Mode wechselt.
                    // autoComplete + textContentType bleiben aus damit kein
                    // Passwort-Manager-Overlay rauspoppt das das normale
                    // Keyboard-Layout überdeckt.
                    keyboardType="default"
                    secureTextEntry={!showPass}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    textContentType="none"
                    returnKeyType="done"
                    onSubmitEditing={() => Keyboard.dismiss()}
                    onFocus={() => setInputFocused(true)}
                    onBlur={() => setInputFocused(false)}
                  />
                </Field>

                {path === "register" && (
                  <View style={styles.strength}>
                    <View style={styles.segs}>
                      {[0, 1, 2, 3].map((i) => (
                        <View
                          key={i}
                          style={[
                            styles.seg,
                            {
                              backgroundColor:
                                i < score ? strengthColors[score] : C.surface4,
                            },
                          ]}
                        />
                      ))}
                    </View>
                    <Text style={styles.strengthLbl}>
                      {t("binchauth.strength.label")}:{" "}
                      <Text
                        style={{
                          color: password ? strengthColors[score] : C.textTertiary,
                          fontWeight: "700",
                        }}
                      >
                        {password ? strengthLabels[score] : "—"}
                      </Text>
                    </Text>
                  </View>
                )}
              </>
            )}
          </Animated.View>

          {/* Primary-CTA direkt unter den Input-Feldern — sitzt INNERHALB
              stepWrap, klebt am Input. Beim Keyboard-Open kommen Input +
              Button gemeinsam nach oben (Sheet-paddingBottom = kbHeight). */}
          <RippleTouch
            onPress={primaryAction}
            disabled={!canSubmit || loading}
            style={[
              styles.primary,
              styles.primaryInline,
              !(canSubmit && !loading) && styles.primaryDisabled,
            ]}
          >
            {canSubmit && !loading ? <GradientFill /> : null}
            {loading ? (
              <ActivityIndicator color={accent.textOnSolid} />
            ) : (
              <>
                <Text
                  style={[
                    styles.primaryTxt,
                    {
                      color: canSubmit
                        ? (accent.textOnSolid as string)
                        : C.textTertiary,
                    },
                  ]}
                >
                  {primaryLabel}
                </Text>
                <ArrowRight
                  size={19}
                  color={canSubmit ? (accent.textOnSolid as string) : C.textTertiary}
                  strokeWidth={2.4}
                />
              </>
            )}
          </RippleTouch>
        </View>

        {/* Social-Section + Terms — sitzt am Sheet-Bottom. Wird komplett
            ausgeblendet sobald irgendein Input fokussiert ist, sonst gibt's
            einen sichtbaren Flash währ das Sheet-padding sich justiert. */}
        <View style={styles.footer}>
          {step === "email" && !inputFocused && (
            <Animated.View entering={FadeIn} exiting={FadeOut}>
              <View style={styles.dividerRow}>
                <View style={styles.line} />
                <Text style={styles.dividerTxt}>{t("binchauth.continuewith")}</Text>
                <View style={styles.line} />
              </View>
              <View style={styles.socials}>
                <Pressable style={styles.soc}>
                  <AppleMark size={19} color={C.white} />
                  <Text style={styles.socTxt}>Apple</Text>
                </Pressable>
                <Pressable style={styles.soc}>
                  <GoogleMark size={19} color={C.white} />
                  <Text style={styles.socTxt}>Google</Text>
                </Pressable>
              </View>
              <Text style={styles.terms}>
                {t("binchauth.terms.prefix")}{" "}
                <Text style={styles.link}>{t("binchauth.terms.tos")}</Text>
                {t("binchauth.terms.middle")}{" "}
                <Text style={styles.link}>{t("binchauth.terms.privacy")}</Text>
                {t("binchauth.terms.suffix")}
              </Text>
            </Animated.View>
          )}
        </View>
      </Animated.View>

      {success && (
        <SuccessOverlay
          mode={success.mode}
          firstName={success.firstName}
          onContinue={close}
        />
      )}
    </Animated.View>
  );
}

/* ──── Success Overlay ───────────────────────────────────────────── */

function SuccessOverlay({
  mode,
  firstName,
  onContinue,
}: {
  mode: Path;
  firstName: string;
  onContinue: () => void;
}) {
  const t = useT();
  const accent = useAccent();
  const reg = mode === "register";
  const [boMood, setBoMood] = useState<BoMood>("waving");

  const p = useSharedValue(0);
  const reveal = useSharedValue(0);

  useEffect(() => {
    p.value = withTiming(1, {
      duration: 1250,
      easing: Easing.bezier(0.22, 0.85, 0.3, 1.05),
    });
    reveal.value = withDelay(
      950,
      withTiming(1, { duration: 500, easing: Easing.out(Easing.cubic) }),
    );
    const t1 = setTimeout(() => setBoMood("happy"), 1250);
    const t2 = setTimeout(() => setBoMood("talking"), 2600);
    const t3 = setTimeout(() => setBoMood("idle"), 4200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [p, reveal]);

  const boStyle = useAnimatedStyle(() => ({
    opacity: interpolate(p.value, [0, 0.14, 1], [0, 1, 1]),
    transform: [
      { translateX: interpolate(p.value, [0, 0.58, 0.78, 1], [150, -14, 8, 0]) },
      { translateY: interpolate(p.value, [0, 0.58, 0.78, 1], [-520, 22, -6, 0]) },
      { scale: interpolate(p.value, [0, 0.58, 0.78, 1], [0.35, 1.1, 0.97, 1]) },
      { rotate: `${interpolate(p.value, [0, 0.58, 0.78, 1], [26, -7, 4, 0])}deg` },
    ],
  }));
  const textStyle = useAnimatedStyle(() => ({
    opacity: reveal.value,
    transform: [{ translateY: interpolate(reveal.value, [0, 1], [14, 0]) }],
  }));

  return (
    <Animated.View entering={FadeIn.duration(300)} style={styles.overlay}>
      <Animated.View style={boStyle}>
        <Bo state={boMood} size={156} />
      </Animated.View>

      <Animated.View style={[styles.successText, textStyle]}>
        <View style={[styles.badge, { borderColor: accent.border }]}>
          <Check size={13} color={accent.solid} strokeWidth={3} />
          <Text style={[styles.badgeTxt, { color: accent.solid }]}>
            {reg ? t("binchauth.success.badge.register") : t("binchauth.success.badge.login")}
          </Text>
        </View>
        <Text style={styles.successTitle}>
          {reg
            ? firstName
              ? t("binchauth.success.title.registerNamed").replace("{name}", firstName)
              : t("binchauth.success.title.register")
            : t("binchauth.success.title.login")}
        </Text>
        <Text style={styles.successSub}>
          {reg ? t("binchauth.success.sub.register") : t("binchauth.success.sub.login")}
        </Text>
        <RippleTouch
          onPress={onContinue}
          style={[styles.primary, styles.successBtn]}
        >
          <GradientFill />
          <Text style={[styles.primaryTxt, { color: accent.textOnSolid }]}>
            {t("binchauth.success.cta")}
          </Text>
          <ArrowRight size={19} color={accent.textOnSolid} strokeWidth={2.4} />
        </RippleTouch>
      </Animated.View>
    </Animated.View>
  );
}

/* ──── Reusable bits ─────────────────────────────────────────────── */

function Field({
  label,
  icon,
  children,
  trailing,
  bad,
  errorText,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  trailing?: React.ReactNode;
  bad?: boolean;
  errorText?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.inputRow, bad && styles.inputRowBad]}>
        {icon}
        {children}
        {trailing}
      </View>
      {bad && errorText ? <Text style={styles.errTxt}>{errorText}</Text> : null}
    </View>
  );
}

function EmailChip({
  email,
  onEdit,
  editLabel,
  accent,
}: {
  email: string;
  onEdit: () => void;
  editLabel: string;
  accent: string;
}) {
  return (
    <View style={styles.chip}>
      <Mail size={15} color={C.textTertiary} />
      <Text style={styles.chipMail} numberOfLines={1}>
        {email}
      </Text>
      <Pressable onPress={onEdit} style={styles.chipEdit} hitSlop={6}>
        <Text style={[styles.chipEditTxt, { color: accent }]}>{editLabel}</Text>
      </Pressable>
    </View>
  );
}

/* ──── Brand-Marks für Social (Apple + Google) ───────────────────── */

function AppleMark({ size = 19, color = C.white }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <SvgPath d="M16.4 13.1c0-2.5 2-3.7 2.1-3.8-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.6.9-.7 0-1.9-.9-3.1-.8-1.6 0-3 .9-3.8 2.4-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.2 0 2-1.1 2.8-2.2.9-1.3 1.2-2.5 1.3-2.6-.1 0-2.5-1-2.5-3.8Zm-2.4-7c.6-.8 1.1-1.9 1-3-.9 0-2.1.6-2.8 1.4-.6.7-1.1 1.8-1 2.9 1 .1 2.1-.5 2.8-1.3Z" />
    </Svg>
  );
}

function GoogleMark({ size = 19, color = C.white }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <SvgPath d="M21.6 12.2c0-.6-.1-1.3-.2-1.9H12v3.6h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.2Z" />
      <SvgPath d="M12 22c2.7 0 4.9-.9 6.6-2.4l-3.2-2.5c-.9.6-2 .9-3.4.9-2.6 0-4.8-1.7-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" />
      <SvgPath d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9l3.3-2.6Z" />
      <SvgPath d="M12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.7 9.4 6 12 6Z" />
    </Svg>
  );
}

/* ──── Styles ────────────────────────────────────────────────────── */

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, backgroundColor: C.bg, zIndex: 1000 },

  band: { height: 220, overflow: "hidden" },
  sun: {
    position: "absolute",
    top: 54,
    right: 54,
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: "#ffe4a8",
    opacity: 0.9,
  },
  hill: {
    position: "absolute",
    left: "-10%",
    right: "-10%",
    borderTopLeftRadius: 500,
    borderTopRightRadius: 500,
  },
  hill1: { bottom: -2, height: 96, backgroundColor: "#0e2740", opacity: 0.96 },
  hill2: { bottom: 26, height: 110, left: "30%", right: "-28%", backgroundColor: "#123146", opacity: 0.9 },
  // Position EXAKT wie auf der Landing-Page (Header in app/(tabs)/index.tsx,
  // styles.headerRow): paddingHorizontal: 22, paddingTop: 8.
  bandRow: {
    position: "absolute",
    top: 60,
    left: 22,
    right: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  // Logo-Style 1:1 wie Landing-Page (Header.logoHeading): fontSize 26,
  // fontWeight 900, letterSpacing -0.6.
  brand: {
    fontSize: 26,
    fontWeight: "900",
    color: C.white,
    letterSpacing: -0.6,
  },
  // Runder Back/Close-Button — Stil identisch zum RouteBanner-Back auf der
  // Map: 44x44, dunkles Surface mit Border, leichtes Shadow für Tiefe.
  closeBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(36,36,37,0.95)",
    borderColor: "#2E2E30",
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  sheet: {
    flex: 1,
    marginTop: -20,
    backgroundColor: C.bg,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 26,
    paddingTop: 18,
    paddingBottom: 28,
  },

  navRow: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 20, minHeight: 38 },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 999,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },
  backSpacer: { width: 0, height: 38 },
  track: { flex: 1, height: 6, borderRadius: 99, backgroundColor: C.surface3, overflow: "hidden" },
  bar: { height: 6, borderRadius: 99 },
  counter: { width: 38, textAlign: "right", color: C.textTertiary, fontSize: 13, fontWeight: "600" },

  // stepWrap NICHT flex:1 mehr — der Continue-Button darin soll direkt
  // unter dem letzten Input-Feld kleben (keine leere Flex-Space dazwischen).
  // Footer (Social-Section) flext sich dann darunter mit flex:1 für den
  // restlichen Platz, wird beim Keyboard-Open vom paddingBottom überdeckt.
  stepWrap: {},
  panel: {},

  eyebrow: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  h1: {
    color: C.white,
    fontSize: 27,
    fontWeight: "800",
    lineHeight: 31,
    letterSpacing: -0.5,
  },
  sub: { color: C.textSecondary, fontSize: 15, lineHeight: 21, marginTop: 9 },

  field: { marginTop: 22 },
  fieldLabel: { color: C.textTertiary, fontSize: 13, fontWeight: "600", marginBottom: 8, marginLeft: 4 },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 56,
    paddingHorizontal: 14,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 16,
  },
  inputRowBad: { borderColor: C.error },
  input: { flex: 1, color: C.white, fontSize: 16, paddingVertical: 0 },
  errTxt: { color: C.error, fontSize: 12, marginTop: 8, marginLeft: 4 },

  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    alignSelf: "flex-start",
    marginTop: 18,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 999,
    paddingVertical: 8,
    paddingLeft: 14,
    paddingRight: 8,
  },
  chipMail: { color: C.white, fontSize: 13, fontWeight: "600", maxWidth: 180 },
  chipEdit: { backgroundColor: C.surface3, paddingVertical: 5, paddingHorizontal: 11, borderRadius: 999 },
  chipEditTxt: { fontSize: 12, fontWeight: "700" },

  strength: { marginTop: 14 },
  segs: { flexDirection: "row", gap: 6 },
  seg: { flex: 1, height: 5, borderRadius: 99 },
  strengthLbl: { color: C.textTertiary, fontSize: 12, marginTop: 8 },

  footer: { flex: 1, justifyContent: "flex-end", paddingTop: 16 },
  primaryInline: { marginTop: 22 },
  primary: {
    height: 56,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    overflow: "hidden", // wichtig für den GradientFill darunter
  },
  primaryDisabled: { backgroundColor: C.surface3 },
  primaryTxt: { fontSize: 16, fontWeight: "700" },

  dividerRow: { flexDirection: "row", alignItems: "center", gap: 14, marginVertical: 16 },
  line: { flex: 1, height: 1, backgroundColor: C.border },
  dividerTxt: { color: C.textTertiary, fontSize: 13 },
  socials: { flexDirection: "row", gap: 12 },
  soc: {
    flex: 1,
    height: 50,
    borderRadius: 16,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
  socTxt: { color: C.white, fontSize: 15, fontWeight: "600" },
  terms: { color: C.textTertiary, fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 16 },
  link: { color: C.textSecondary, textDecorationLine: "underline" },

  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(8,8,8,0.86)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 30,
  },
  successText: { alignItems: "center", marginTop: -4 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 14,
    backgroundColor: "rgba(127,234,77,0.12)",
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 13,
    borderRadius: 999,
  },
  badgeTxt: { fontSize: 12, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  successTitle: { color: C.white, fontSize: 28, fontWeight: "800", letterSpacing: -0.5, textAlign: "center" },
  successSub: { color: C.textSecondary, fontSize: 15, lineHeight: 22, textAlign: "center", marginTop: 10, maxWidth: 300 },
  successBtn: { marginTop: 26, paddingHorizontal: 40, alignSelf: "center" },
});
