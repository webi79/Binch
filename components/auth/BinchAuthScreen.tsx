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
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Dimensions,
  Keyboard,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { usePalette } from "@/lib/theme/appBg";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  SlideInLeft,
  SlideInRight,
  interpolate,
  runOnJS,
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
import {
  isAppleAvailable,
  isGoogleAvailable,
  signInWithApple,
  signInWithGoogle,
  SignInCancelled,
} from "@/lib/auth/socialSignIn";
import { usePressBounce } from "@/lib/motion";
import { SCREEN_CORNER_RADIUS, SHEET_IN, SHEET_OUT, markSheetMoving } from "@/lib/nav/overlayCover";
import { scaledStyles } from "@/lib/ui/compact";

/** Siehe `styles.body`: Fenstermaß beim Laden, also ohne Tastatur. */
const WINDOW_H = Dimensions.get("window").height;


const C = {
  bg: "#0D0D0D",
  surface2: "#171719",
  surface3: "#212123",
  surface4: "#212123",
  border: "#212123",
  white: "#F4F4F5",
  textSecondary: "#C8C8CC",
  textTertiary: "#8E8E93",
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

/**
 * Eins zu eins der Weg des Such-Blattes — und der Unterschied ist NICHT die
 * Kurve, sondern der Mechanismus.
 *
 * Vorher: `if (!open) return null` plus `entering`/`exiting`. Das hatte zwei
 * Folgen, die beide teuer sind:
 *
 *  1. Der gesamte Baum entstand in genau dem Bild, in dem die Bewegung
 *     losfährt — Verlaufsband, Felder, Anbieter-Knöpfe. Das Such-Blatt hält
 *     seinen Inhalt dauerhaft gemountet und schreibt ausdrücklich hin, warum:
 *     „sonst fiele pro Öffnung ein Aufbau an, und zwar genau im Bild, in dem
 *     die Bewegung startet."
 *  2. `SlideInDown` animiert `originY` — und Reanimated hat auf Android eine
 *     feste Liste von Eigenschaften, die den synchronen Weg direkt an die
 *     native View nehmen dürfen. `transform` steht darin, `originY` nicht.
 *     Alles außerhalb dieser Liste läuft pro Bild über einen Klon des
 *     Schattenbaums, einen Yoga-Durchlauf und eine Einbau-Transaktion. Bei
 *     300ms sind das rund 20 bis 36 solcher Durchgänge für einen Baum dieser
 *     Größe — auf demselben Strang, auf dem die Bewegung läuft.
 *
 * Jetzt derselbe Aufbau wie beim Such-Blatt: dauerhaft gemountet, eigener
 * Wert, `transform`, Start im nächsten Bild nach dem Commit.
 */
export function BinchAuthScreen() {
  return <Sheet />;
}

function Sheet() {
  const palette = usePalette();
  const open = useSearchStore((s) => s.authOverlayOpen);
  /**
   * Die Bewegung — Zeile für Zeile die des Such-Blattes.
   *
   * `sheetY` ist der Abstand nach unten: 0 oben angekommen, WINDOW_H unterhalb
   * des Bildrands. Beim Öffnen erst parken, dann im NÄCHSTEN Bild losfahren —
   * der Commit, der die Sichtbarkeit umschaltet, ist dann durch und die
   * Bewegung hat den Strang für sich.
   */
  const sheetY = useSharedValue(WINDOW_H);
  const [moving, setMoving] = useState(false);
  const [mounted, setMounted] = useState(open);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    if (open) {
      setMounted(true);
      setMoving(true);
      sheetY.value = WINDOW_H;
      rafRef.current = requestAnimationFrame(() => {
        markSheetMoving(SHEET_IN.duration);
        sheetY.value = withTiming(0, SHEET_IN, (finished) => {
          "worklet";
          if (!finished) return;
          runOnJS(setMoving)(false);
        });
      });
      return () => {
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      };
    }
    if (!mounted) return undefined;
    setMoving(true);
    markSheetMoving(SHEET_OUT.duration);
    sheetY.value = withTiming(WINDOW_H, SHEET_OUT, (finished) => {
      "worklet";
      if (!finished) return;
      runOnJS(setMoving)(false);
      // Erst wenn das Blatt unten steht, den Inhalt wieder freigeben.
      runOnJS(setMounted)(false);
    });
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const sheetStyleAnim = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetY.value }],
  }));
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
  /** Spiegel von `loading` als Ref — die gemeinsame Sperre in `runSocial` muss
   *  den Wert im SELBEN Bild sehen, nicht den aus dem letzten Render. */
  const loadingRef = useRef(false);
  loadingRef.current = loading;
  /** Druck-Effekt wie an den Kacheln im Landingscreen. */
  const primaryBounce = usePressBounce();

  /**
   * Läuft dieser Bildschirm noch?
   *
   * Anmeldung und Registrierung dauern ein paar hundert Millisekunden. Wer in
   * dieser Zeit abbricht, war danach trotzdem angemeldet: Die Antwort kam an,
   * schrieb Token und Nutzer in den Speicher und legte den Erfolgs-Schritt an —
   * auf einem Bildschirm, den es nicht mehr gab. Alles, was nach einem `await`
   * schreibt, fragt darum erst hier nach, ob es überhaupt noch jemanden gibt,
   * den es angeht.
   *
   * Der Ref stimmt, weil der äußere Rahmen `null` liefert, sobald die
   * Überlagerung zu ist — dieser Baum wird dabei wirklich abgebaut.
   *
   * Zwischendurch war das Schließen während des Ladens zusätzlich gesperrt. Das
   * ist wieder raus: Der Netz-Zeitgeber steht bei 20 Sekunden, und so lange darf
   * niemand in einem Bildschirm festsitzen, den er verlassen will. Bricht jemand
   * eine Registrierung ab, die serverseitig durchläuft, bleibt das folgenlos —
   * der nächste Versuch bekommt 409 und wird unten auf die Anmeldung geleitet.
   */
  const aliveRef = useRef(true);
  useEffect(() => () => {
    aliveRef.current = false;
  }, []);

  /**
   * Anmeldung über Apple oder Google.
   *
   * `social` ist gleichzeitig Sperre und Anzeige: Solange ein Anbieter läuft,
   * sind beide Knöpfe gesperrt. Ohne das öffnete ein zweiter Tipp einen zweiten
   * Anbieter-Dialog, und die später eintreffende Antwort überschriebe die
   * frühere.
   */
  const [social, setSocial] = useState<"apple" | "google" | null>(null);
  /** Eigener Fehlertext — `errorMsg` gehört zum Passwort-Feld und wird auf
   *  diesem Schritt gar nicht gerendert. */
  const [socialError, setSocialError] = useState<string | null>(null);
  /**
   * Sperre als Ref, nicht als Zustand.
   *
   * Zwei Finger auf Apple und Google sehen im selben Render beide
   * `social === null` und starten beide. Ein Ref greift schon im selben Bild.
   */
  const busyRef = useRef(false);
  /** `null` = noch nicht geprüft. Mit `false` als Start blitzte auf iOS erst
   *  ein alleiniger, volle Breite füllender Google-Knopf auf und sprang dann
   *  auf die Hälfte, sobald Apple dazukam. */
  const [appleReady, setAppleReady] = useState<boolean | null>(null);
  const googleReady = isGoogleAvailable();
  useEffect(() => {
    let alive = true;
    void isAppleAvailable().then((v) => {
      if (alive) setAppleReady(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const runSocial = async (provider: "apple" | "google") => {
    // Beide Wege teilen sich die Sperre: Der Passwort-Weg darf nicht parallel
    // laufen, sonst wechselt er den Schritt, während der Anbieter-Dialog offen
    // ist.
    if (busyRef.current || loadingRef.current) return;
    busyRef.current = true;
    setSocial(provider);
    setSocialError(null);
    haptic("button");
    try {
      const res = provider === "apple" ? await signInWithApple() : await signInWithGoogle();
      // Dieselbe Lebend-Prüfung wie beim Passwort-Weg: Der Anbieter-Dialog
      // dauert Sekunden, und wer in der Zeit abbricht, war sonst danach
      // trotzdem angemeldet.
      if (!aliveRef.current) return;
      setAuth(res.token, res.user);
      setSuccess({ mode: "login", firstName: (res.user.firstName ?? "").trim() });
      haptic("important");
    } catch (err) {
      if (!aliveRef.current) return;
      // Abbruch ist kein Fehler — dann still zurück zum Formular.
      if (err instanceof SignInCancelled) return;
      const msg = (err instanceof Error ? err.message : "").toLowerCase();
      // Die drei Fälle, die der Server unterscheidet — jeder braucht eine
      // andere Ansage, sonst steht der Nutzer ohne Weg da.
      setSocialError(
        // Ratenbegrenzung zuerst prüfen: Sie greift VOR allem anderen, und der
        // Auffangtext („noch einmal versuchen") ist dafür der schlechteste
        // mögliche Rat — genau das Wiederholen verlängert die Sperre.
        msg.includes("too many")
          ? t("binchauth.social.toomany")
          : msg.includes("already registered")
          ? // Es gibt bereits ein Konto MIT Passwort für diese Adresse. Wir
            // hängen den Anbieter bewusst nicht daran (das wäre eine
            // Konto-Übernahme, siehe Server) — also den Passwort-Weg anbieten.
            t("binchauth.social.usepassword")
          : msg.includes("no email")
            ? t("binchauth.social.noemail")
            : msg.includes("not configured")
              ? t("binchauth.social.unavailable")
              : t("binchauth.social.failed"),
      );
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setSocial(null);
    }
  };
  const appleBounce = usePressBounce();
  const googleBounce = usePressBounce();
  const [success, setSuccess] = useState<{ mode: Path; firstName: string } | null>(
    null,
  );

  /**
   * Beim Schließen alles zurücksetzen — der Bildschirm wird nicht mehr abgebaut.
   *
   * Vorher hing dieses Blatt an `if (!open) return null`, jede Öffnung fing
   * also bei null an. Seit es für die Bewegung dauerhaft gemountet bleibt,
   * überlebt der Zustand: Nach einer erfolgreichen Anmeldung stünde beim
   * nächsten Öffnen die Erfolgsmeldung da, ohne Weg zurück zum Formular. Und
   * ein halb ausgefülltes Formular samt Klartext-Passwort bliebe im Speicher.
   *
   * Erst NACH der Ausfahrt, damit man das Zurücksetzen nicht sieht.
   */
  useEffect(() => {
    if (open) {
      aliveRef.current = true;
      return;
    }
    aliveRef.current = false;
    const id = setTimeout(() => {
      setStep("email");
      setPath("register");
      setEmail("");
      setName("");
      setPassword("");
      setSuccess(null);
      setLoading(false);
      setErrorMsg(null);
      setErrors({});
      setSocial(null);
    }, SHEET_OUT.duration + 40);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const order: Step[] = path === "login" ? ["email", "password"] : ["email", "name", "password"];
  const total = step === "email" ? 2 : order.length;
  const idx = order.indexOf(step);

  /**
   * DAS war die Ursache — und sie stand die ganze Zeit hier.
   *
   * `paddingBottom = Tastaturhöhe` hob den Inhalt des Blattes Bild für Bild mit
   * der Tastatur an. Genau das schiebt den Google-Knopf nach oben; alle meine
   * Umbauten davor (feste Höhe, Ausblenden, Beschnitt) haben an dieser Zeile
   * vorbeigearbeitet.
   *
   * Sie war zusätzlich teuer: `paddingBottom` steht NICHT in Reanimateds Liste
   * der Eigenschaften, die auf Android synchron an die native View gehen
   * dürfen. Jedes Bild der Tastatur-Bewegung lief damit über einen Klon des
   * Schattenbaums samt Yoga-Durchlauf — dieselbe Krankheit, die die Fahrt des
   * Blattes hatte, nur eben bei jedem Tippen.
   *
   * Fester Abstand. Verdeckt wird dadurch nichts: Feld und „Weiter" sitzen im
   * oberen Zweidrittel, die Tastatur beginnt darunter.
   */
  const sheetStyle = { paddingBottom: 28 } as const;

  // Social-Section sofort ausblenden sobald irgendein Input fokussiert wird —
  // sonst sieht der User die Apple/Google-Buttons kurz nach oben fliegen
  // bevor der paddingBottom-Layout-Pass die Position korrigiert.
  // Wir tracken's via TextInput onFocus/onBlur (sicher auf beiden
  // Plattformen, fired noch vor keyboard.height-Updates).
  /**
   * KEIN `inputFocused` mehr.
   *
   * Daran hing das Ausblenden der Anbieter-Knöpfe, solange sie der Tastatur
   * ausweichen mussten. Sie weichen ihr nicht mehr aus — der Körper behält
   * seine Höhe (siehe `styles.body`), die Tastatur legt sich einfach darüber.
   * Geblieben war ein Zustand samt zwei Zuhörern, den niemand mehr liest.
   */

  /**
   * Zusätzlich am tatsächlichen Zustand der Tastatur — wegen der Ausfüllhilfe.
   *
   * Das Ausblenden hing allein am Fokus. Wer das gespeicherte Passwort aus der
   * Vorschlagszeile der Tastatur übernimmt, löst auf Android aber einen
   * Fokuswechsel aus: Das Feld verliert kurz den Fokus, `onBlur` feuert, und
   * die Anbieter-Sektion klappt wieder auf — während die Tastatur noch steht.
   * Das Fenster ist zu dem Zeitpunkt um deren Höhe geschrumpft, die Sektion
   * sitzt also mitten im Inhalt und deckt „Weiter" zu.
   *
   * „Fokussiert" und „die Tastatur steht im Weg" sind zwei verschiedene Dinge —
   * darüber steht das schon einmal. Hier zählt das zweite.
   */
  // KEIN Tastatur-Merker mehr: Der Fuß weicht ihr nicht aus, seit der Körper
  // seine Höhe behält (siehe `styles.body`). Er wurde nur noch geschrieben.


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

  // Android-Zurück (Hardware-Taste UND Zurück-WISCHGESTE — die feuert dasselbe
  // Event). Ohne das ließ sich der Auth-Screen per Geste nicht verlassen: Er ist
  // ein Root-Overlay, kein Router-Screen, hat also kein eingebautes Zurück.
  // Verhalten wie der Chevron oben links: erst einen Schritt zurück, und auf dem
  // ersten Schritt das Overlay schließen.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    // NUR wenn das Blatt auch offen ist. Es bleibt jetzt dauerhaft gemountet
    // (siehe `BinchAuthScreen`) — ohne diese Prüfung schluckte es die
    // Zurück-Geste der ganzen App, auch wenn es unsichtbar unten steht.
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      // Liegt die Erfolgsmeldung darüber, gibt es nichts zurückzugehen — sonst
      // blättert man unsichtbar hinter ihr durch die Schritte, und erst der
      // dritte Druck schließt.
      if (success) {
        close();
        return true;
      }
      if (idx > 0) {
        back();
      } else {
        close();
      }
      return true; // Event verbraucht — sonst schlösse Android die ganze App.
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, close, open, success]);

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
      if (!aliveRef.current) return;
      const next: Path = exists ? "login" : "register";
      setPath(next);
      goTo(next === "login" ? "password" : "name", "fwd");
    } catch (err) {
      if (!aliveRef.current) return;
      // Network/Server-Error: defaulten auf register-Pfad, User kann jedenfalls
      // weiter (bei Register mit existing email würde der Server eh 409 melden).
      setPath("register");
      goTo("name", "fwd");
    } finally {
      if (aliveRef.current) setLoading(false);
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
      if (!aliveRef.current) return;
      setAuth(res.token, res.user);
      const firstName = (res.user.firstName ?? name.trim().split(" ")[0] ?? "").trim();
      setSuccess({ mode: path, firstName });
      haptic("important");
    } catch (err) {
      if (!aliveRef.current) return;
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
      if (aliveRef.current) setLoading(false);
    }
  }

  function primaryAction() {
    // Kein Passwort-Schritt, während ein Anbieter-Dialog offen ist — sonst
    // wechselt der Bildschirm unter dem laufenden Dialog den Schritt.
    if (busyRef.current) return;
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
  /**
   * Der Schritt fährt erst ab dem ZWEITEN Mal von der Seite herein.
   *
   * Beim Aufsetzen liefen zwei Layout-Animationen gleichzeitig: das Blatt von
   * unten und der Inhalt darin von rechts. Beide sind Reanimated-Ein-
   * sprünge, beide messen im selben Bild, und der Inhalt ist der teurere —
   * Verlaufsband, Felder, Anbieter-Knöpfe. Genau daher das Haken beim
   * Hochfahren.
   *
   * Für den eigentlichen Zweck ist der seitliche Einzug beim Aufsetzen ohnehin
   * überflüssig: Er soll den WECHSEL zwischen E-Mail-, Passwort- und
   * Namensschritt zeigen. Beim ersten Schritt gibt es nichts zu wechseln.
   */
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setEntered(true), SHEET_IN.duration + 40);
    return () => clearTimeout(id);
  }, []);

  return (
    <Animated.View
      /* Die Kurve MUSS mit: Eine Ein-/Aussprung-Animation nimmt sonst
         Reanimateds Standard (`inOut(quad)`), und der wirkt linear — siehe die
         Rechnung an SHEET_IN. Nur die Dauer zu übernehmen reicht also nicht. */
      style={[styles.root, { backgroundColor: palette.bg }, sheetStyleAnim]}
      // Für die DAUER der Bewegung eine GPU-Ebene — genau wie beim Such-Blatt.
      // Dauerhaft wäre sie bei jeder Eingabe im Formular neu zu rastern.
      renderToHardwareTextureAndroid={Platform.OS === "android" && moving}
    >
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/**
        * Der INHALT hängt an `mounted`, nicht die Hülle.
        *
        * Für die Bewegung muss der Wert samt Effekt dauerhaft bestehen — sonst
        * gäbe es beim Öffnen wieder einen Aufbau im Startbild. Der schwere Teil
        * darf aber nicht dauerhaft im Wurzelbaum liegen: Verlaufsband, Felder,
        * Anbieter-Knöpfe und die Erfolgsmeldung würden sonst bei JEDER
        * Vermessung des Baums mitgemessen — und die läuft unter `adjustResize`
        * bei jeder Tastatur, also mitten in fremde Fahrten hinein.
        *
        * `mounted` steht von der Öffnung bis zum Ende der Ausfahrt auf wahr:
        * gebaut wird also ein Bild VOR der Bewegung, abgebaut erst danach.
        */}
      {mounted && (
        <>

      {/**
        * Feste Höhe aus dem Fenstermaß beim LADEN — nicht gemessen.
        *
        * Gemessen war falsch, und der Screenshot zeigt genau warum: Die erste
        * Messung fällt nicht zwingend in einen Moment ohne Tastatur. Wird
        * dieser Bildschirm geöffnet, während sie schon steht — oder misst er
        * erst nach ihrem Erscheinen —, brennt sich die verkleinerte Höhe ein.
        * Der Fuß rückt dann dauerhaft nach oben und legt sich über „Weiter".
        *
        * Das Fenstermaß beim Laden der App kennt keine Tastatur. Die Wurzel
        * darüber beschneidet (`overflow: hidden`), es ragt also nichts hinaus —
        * das war der Fehler der Fassung davor, die diese Höhe der WURZEL gab.
        */}
      {/**
        * `pointerEvents` sitzt HIER, nicht auf dem animierten Knoten.
        *
        * Es wechselt in genau dem Durchgang, in dem die Fahrt beginnt, und ein
        * Eigenschafts-Wechsel ist auf Fabric ein Commit auf eben dem Knoten,
        * den Reanimated Bild für Bild beschreibt. Dieselbe Korrektur wie bei
        * beiden Wählern.
        */}
      <View
        style={[styles.body, { height: WINDOW_H }]}
        pointerEvents={open ? "auto" : "none"}
      >

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
          colors={["transparent", "rgba(13,13,13,0.35)", C.bg]}
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
      <Animated.View style={[styles.sheet, { backgroundColor: palette.s1 }, sheetStyle]}>
        {/* nav: back + progress */}
        <View style={styles.navRow}>
          {idx > 0 ? (
            <Pressable onPress={back} style={[styles.backBtn, { backgroundColor: palette.s2, borderColor: palette.border }]} hitSlop={10}>
              <ChevronLeft size={19} color={C.white} strokeWidth={2.4} />
            </Pressable>
          ) : (
            <View style={styles.backSpacer} />
          )}
          <View
            style={[styles.track, { backgroundColor: palette.s3 }]}
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
          <Animated.View
            key={step}
            entering={entered ? slideIn.duration(420) : undefined}
            style={styles.panel}
          >
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
          {/* Am Aufsetzen ausgelöst, nicht an `onPressIn`: RippleTouch hält das
              um 50ms zurück, ein Tipp ist meist kürzer — man sähe nichts. */}
          <Animated.View
            style={[styles.primaryInline, primaryBounce.style]}
            onTouchStart={canSubmit && !loading ? primaryBounce.onPressIn : undefined}
            onTouchEnd={primaryBounce.onPressOut}
            onTouchCancel={primaryBounce.onPressOut}
          >
          <RippleTouch
            onPress={primaryAction}
            disabled={!canSubmit || loading}
            style={[
              styles.primary,
              !(canSubmit && !loading) && [styles.primaryDisabled, { backgroundColor: palette.s3 }],
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
          </Animated.View>
        </View>

        {/* Social-Section + Terms — sitzt am Sheet-Bottom. Wird komplett
            ausgeblendet sobald irgendein Input fokussiert ist, sonst gibt's
            einen sichtbaren Flash währ das Sheet-padding sich justiert. */}
        <View style={styles.footer}>
          {step === "email" && (appleReady === true || googleReady) && (
            <Animated.View entering={FadeIn} exiting={FadeOut}>
              <View style={styles.dividerRow}>
                <View style={styles.line} />
                <Text style={styles.dividerTxt}>{t("binchauth.continuewith")}</Text>
                <View style={styles.line} />
              </View>
              {/* Auch hier der Druck-Effekt. Die Breitenverteilung (`flex: 1`)
                  muss dabei an den ÄUSSEREN Knoten: In einer Zeile teilt der den
                  Platz auf — am Knopf gelassen streckte er in seinem eigenen,
                  senkrechten Rahmen und beide würden schmal. */}
              {/* Nur zeigen, was auch geht: Apple gibt es ausschließlich auf
                  iOS, Google nur mit hinterlegter Client-ID. Ein Knopf, der
                  nichts tut, ist schlechter als keiner. */}
              <View style={styles.socials}>
                {appleReady === true ? (
                  <Animated.View
                    style={[styles.socWrap, appleBounce.style]}
                    onTouchStart={appleBounce.onPressIn}
                    onTouchEnd={appleBounce.onPressOut}
                    onTouchCancel={appleBounce.onPressOut}
                  >
                    <Pressable
                      style={[styles.soc, { backgroundColor: palette.s2 }]}
                      disabled={social != null}
                      onPress={() => runSocial("apple")}
                    >
                      {social === "apple" ? (
                        <ActivityIndicator color={C.white} />
                      ) : (
                        <>
                          <AppleMark size={19} color={C.white} />
                          <Text style={styles.socTxt}>Apple</Text>
                        </>
                      )}
                    </Pressable>
                  </Animated.View>
                ) : null}
                {googleReady ? (
                  <Animated.View
                    style={[styles.socWrap, googleBounce.style]}
                    onTouchStart={googleBounce.onPressIn}
                    onTouchEnd={googleBounce.onPressOut}
                    onTouchCancel={googleBounce.onPressOut}
                  >
                    <Pressable
                      style={[styles.soc, { backgroundColor: palette.s2 }]}
                      disabled={social != null}
                      onPress={() => runSocial("google")}
                    >
                      {social === "google" ? (
                        <ActivityIndicator color={C.white} />
                      ) : (
                        <>
                          <GoogleMark size={19} color={C.white} />
                          <Text style={styles.socTxt}>Google</Text>
                        </>
                      )}
                    </Pressable>
                  </Animated.View>
                ) : null}
              </View>
              {/* Eigene Fehlerzeile. `errorMsg` wird sonst NUR am Passwort-Feld
                  gerendert — und das gibt es auf diesem Schritt gar nicht. Eine
                  fehlgeschlagene Anbieter-Anmeldung endete damit vollkommen
                  stumm: Spinner aus, Knopf wieder da, keine Erklärung. */}
              {socialError ? (
                <Text style={styles.socialErr}>{socialError}</Text>
              ) : null}
            </Animated.View>
          )}
          {/* AGB und Datenschutz stehen AUSSERHALB der Anbieter-Bedingung.
              Sie lagen darin und verschwanden damit auf jedem Gerät, auf dem
              weder Apple noch Google eingerichtet ist — also derzeit auf jedem
              Android-Build. Ein Rechtshinweis darf nicht an der Verfügbarkeit
              eines Anmeldeknopfes hängen. */}
          {step === "email" && (
            <Animated.View entering={FadeIn} exiting={FadeOut}>
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
      </View>

      {success && (
        <SuccessOverlay
          mode={success.mode}
          firstName={success.firstName}
          onContinue={close}
        />
      )}
        </>
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
  const palette = usePalette();
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.inputRow, { backgroundColor: palette.s2, borderColor: palette.border }, bad && styles.inputRowBad]}>
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
  const palette = usePalette();
  return (
    <View style={[styles.chip, { backgroundColor: palette.s2 }]}>
      <Mail size={15} color={C.textTertiary} />
      <Text style={styles.chipMail} numberOfLines={1}>
        {email}
      </Text>
      <Pressable onPress={onEdit} style={[styles.chipEdit, { backgroundColor: palette.s3 }]} hitSlop={6}>
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

const styles = scaledStyles({
  root: {
    /**
     * Die Wurzel begrenzt WIE IMMER — fest wird die Höhe eine Ebene tiefer.
     *
     * Die App läuft mit `adjustResize`: Geht die Tastatur auf, schrumpft das
     * Fenster — und mit `bottom: 0` schrumpft dieses Blatt mit. Alles am
     * unteren Rand rückt dann nach oben, also genau die Anbieter-Knöpfe und der
     * „oder weiter mit"-Balken. Das Ausblenden davon war nur ein Pflaster: Es
     * hängt am Fokus-Ereignis, das Fenster schrumpft aber schon vorher — und
     * dieses eine Bild dazwischen ist das Aufblinzeln.
     *
     * Ich hatte deshalb die Wurzel selbst auf eine feste Höhe gesetzt — und
     * damit einen zweiten Fehler gebaut: Sie ragte unten über ihren Platz
     * hinaus, und im Bereich der Navigationsleiste schien Inhalt durch.
     *
     * Richtig ist die Ebene darunter: Die Wurzel bleibt exakt so groß wie ihr
     * Platz (also auch die runden Ecken und der Beschnitt stimmen), und der
     * INHALT darin behält seine einmal gemessene Höhe. Schrumpft das Fenster,
     * wird er unten abgeschnitten statt zusammengeschoben — die Tastatur legt
     * sich einfach darüber. Siehe `body`.
     */
    ...StyleSheet.absoluteFillObject,
    backgroundColor: C.bg,
    zIndex: 1000,
    // Gerundete Ecken beim Hochfahren, passend zum Geräte-Display — wie bei
    // allen anderen bildschirmfüllenden Slides der App.
    borderRadius: SCREEN_CORNER_RADIUS,
    overflow: "hidden",
  },

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
    backgroundColor: "rgba(27,27,27,0.95)",
    borderColor: "#212123",
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

  /**
   * Behält die einmal gemessene Höhe — siehe `root`. Ohne feste Höhe schöbe das
   * schrumpfende Fenster alles darin nach oben.
   */
  /**
   * KEIN `flex: 1` — das machte die feste Höhe wirkungslos.
   *
   * `flex: 1` bedeutet in Yoga `flexBasis: 0` plus `flexGrow/Shrink: 1`, und
   * die Basis schlägt auf der Hauptachse eine gesetzte Höhe. Der Körper hat
   * sich damit weiter mit dem Fenster verkleinert, obwohl daneben `height`
   * stand — deshalb schob die Tastatur den Google-Knopf immer noch über
   * „Weiter", trotz der Umbauten davor.
   */
  body: { height: WINDOW_H },
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
  /** Breitenverteilung am äußeren Knoten — siehe Kommentar im JSX. */
  socWrap: { flex: 1 },
  soc: {
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
  socialErr: { color: C.error, fontSize: 13, textAlign: "center", marginTop: 12, lineHeight: 18 },
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
