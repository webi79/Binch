/**
 * „Chat umbenennen" — der einzige Dialog der App mit einem Eingabefeld.
 *
 * Warum eine eigene Komponente und nicht `showAlert`: Der gemeinsame
 * Alert-Wirt (`components/ui/AppAlertHost.tsx`) kennt Titel, Text und Knöpfe —
 * ein Feld war nie vorgesehen. Ihn dafür zu erweitern hieße, jeden bestehenden
 * Dialog der App anzufassen, damit genau einer etwas mehr kann.
 *
 * Die Gestalt ist deshalb bewusst ABGESCHRIEBEN statt neu erfunden: Kreis mit
 * Zeichen, Titel, erklärende Zeile, voller Akzent-Knopf, Geister-Knopf darunter
 * — dieselben Maße und Farbwerte wie im Alert-Wirt. Zwei Dialoge, die sich nur
 * in der Mitte unterscheiden, sollen sich auch nur dort unterscheiden.
 *
 * Er liegt in einem eigenen Fenster (`Modal`), und das ist hier nicht Zierde:
 * Aufgerufen wird er aus der Chat-Schublade, und die füllt nur die linken
 * knapp zwei Drittel des Bildschirms; der Rest gehört dem geschrumpften
 * Bo-Screen. Ein Dialog INNERHALB der Schublade läge halb darunter.
 */
import { useEffect, useState } from "react";
import { TITLE_GAP } from "@/lib/theme/spacing";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut } from "react-native-reanimated";
import { Pencil } from "lucide-react-native";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { haptic } from "@/lib/haptics";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { scaledStyles } from "@/lib/ui/compact";

const tokens = {
  border: "rgba(255,255,255,0.08)",
  white: "#F4F4F5",
  gray200: "#C8C8CC",
  gray300: "#8E8E93",
  scrim: "rgba(0,0,0,0.55)",
} as const;

/** Wie im Alert-Wirt: der Kreis, der die Art des Dialogs ansagt. */
const ICON_CIRCLE = 72;

/** Derselbe Deckel wie in der Datenbank (`title varchar(120)`). Ein Feld, das
 *  mehr annimmt als der Server speichert, endet in einem 400 nach dem Tippen. */
const TITLE_MAX = 120;

export interface RenameThreadDialogProps {
  visible: boolean;
  /** Der bestehende Titel — steht beim Öffnen im Feld und ist vorausgewählt. */
  initialTitle: string;
  title: string;
  /** Eine Zeile, die sagt, wozu das Feld da ist. */
  body: string;
  placeholder: string;
  confirmLabel: string;
  cancelLabel: string;
  onCancel: () => void;
  onConfirm: (title: string) => void;
}

export function RenameThreadDialog({
  visible,
  initialTitle,
  title,
  body,
  placeholder,
  confirmLabel,
  cancelLabel,
  onCancel,
  onConfirm,
}: RenameThreadDialogProps) {
  const accent = useAccent();
  const palette = usePalette();
  const [value, setValue] = useState(initialTitle);
  const [focused, setFocused] = useState(false);

  /**
   * Beim ÖFFNEN zurücksetzen, nicht beim Schließen.
   *
   * Zurücksetzen im Schließen wäre sichtbar: Der Dialog blendet aus, und
   * während er das tut, springt der Text im Feld auf den alten Wert.
   */
  useEffect(() => {
    if (!visible) return;
    setValue(initialTitle);
  }, [visible, initialTitle]);

  const trimmed = value.trim();
  /**
   * Gesperrt ist der Knopf NUR bei leerem Feld.
   *
   * Vorher musste sich der Titel auch geändert haben — und weil das Feld mit
   * dem alten Titel öffnet, stand der Knopf beim Aufschlagen des Dialogs
   * grundsätzlich abgeblendet da. Der Dialog wirkte dadurch kaputt, bevor man
   * etwas getan hatte. Denselben Namen noch einmal zu bestätigen ist kein
   * Fehler, es kostet nur einen Aufruf.
   */
  const canSave = trimmed.length > 0;

  const submit = () => {
    if (!canSave) return;
    haptic("button");
    Keyboard.dismiss();
    onConfirm(trimmed);
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onCancel}>
      <Animated.View
        entering={FadeIn.duration(140)}
        exiting={FadeOut.duration(120)}
        style={styles.scrim}
      >
        {/* Tipp daneben bricht ab — wie in jedem anderen Dialog der App.
            `accessible={false}`, sonst fängt die Fläche auf iOS die
            Sprachausgabe ein und verdeckt die Knöpfe darin. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} accessible={false} />
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.centerer}
          pointerEvents="box-none"
        >
          <Animated.View
            entering={ZoomIn.duration(160)}
            exiting={ZoomOut.duration(120)}
            style={[styles.card, { backgroundColor: palette.s2 }]}
          >
            <View style={[styles.iconCircle, { backgroundColor: accent.subtle }]}>
              <Pencil size={30} color={accent.solid} strokeWidth={2} />
            </View>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.body}>{body}</Text>
            <TextInput
              value={value}
              onChangeText={setValue}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={placeholder}
              placeholderTextColor={tokens.gray300}
              maxLength={TITLE_MAX}
              autoFocus
              selectTextOnFocus
              returnKeyType="done"
              onSubmitEditing={submit}
              /**
               * Die Kante zeigt den Fokus an, statt ihn dauerhaft zu behaupten.
               *
               * Vorher trug das Feld IMMER den Akzent-Rahmen. Ein Feld, das
               * immer aussieht wie das aktive, sagt nichts mehr — und es zog
               * als grellstes Element den Blick vom Knopf weg, der die
               * Handlung trägt.
               */
              style={[
                styles.input,
                { backgroundColor: palette.s3 },
                { borderColor: focused ? accent.border : tokens.border },
              ]}
            />
            {/* `RippleTouch`, nicht `Pressable`: An `Pressable` bleibt
                `android_ripple` unsichtbar, weil NativeWind die Eigenschaft in
                seiner JSX-Zwischenschicht schluckt — das steht in der
                Hauskomponente selbst. Der Ripple ist hier dunkel, weil die
                Fläche der Akzentton ist. */}
            <RippleTouch
              onPress={submit}
              disabled={!canSave}
              accessibilityLabel={confirmLabel}
              rippleColor="rgba(0,0,0,0.14)"
              style={[
                styles.solidBtn,
                { backgroundColor: accent.solid },
                // Nur der leere Titel blendet ab — siehe `canSave`.
                !canSave && styles.disabled,
              ]}
            >
              <Text style={[styles.solidLabel, { color: accent.textOnSolid }]}>
                {confirmLabel}
              </Text>
            </RippleTouch>
            <Pressable onPress={onCancel} accessibilityRole="button" style={styles.ghostBtn}>
              <Text style={styles.ghostLabel}>{cancelLabel}</Text>
            </Pressable>
          </Animated.View>
        </KeyboardAvoidingView>
      </Animated.View>
    </Modal>
  );
}

const styles = scaledStyles({
  scrim: { flex: 1, backgroundColor: tokens.scrim },
  centerer: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28 },
  card: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: tokens.border,
    paddingTop: 28,
    paddingHorizontal: 24,
    paddingBottom: 16,
    alignItems: "center",
  },
  iconCircle: {
    width: ICON_CIRCLE,
    height: ICON_CIRCLE,
    borderRadius: ICON_CIRCLE / 2,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  title: {
    fontSize: 21,
    fontWeight: "800",
    letterSpacing: -0.6,
    color: tokens.white,
    textAlign: "center",
  },
  body: {
    marginTop: TITLE_GAP,
    fontSize: 14,
    lineHeight: 21,
    color: tokens.gray200,
    textAlign: "center",
  },
  input: {
    alignSelf: "stretch",
    marginTop: 20,
    height: 52,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 16,
    fontSize: 16,
    color: tokens.white,
  },
  solidBtn: { alignSelf: "stretch", marginTop: 20, borderRadius: 16, overflow: "hidden" },
  solidLabel: { fontSize: 17, fontWeight: "700", textAlign: "center", paddingVertical: 16 },
  disabled: { opacity: 0.4 },
  ghostBtn: {
    alignSelf: "stretch",
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  ghostLabel: { fontSize: 14, fontWeight: "600", color: tokens.gray300 },
});
