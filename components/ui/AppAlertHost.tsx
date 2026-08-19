import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut } from "react-native-reanimated";
import { useAlertStore, type AlertButton } from "@/lib/alert";
import { GradientFill } from "@/components/ui/GradientFill";
import { haptic } from "@/lib/haptics";
import { usePalette } from "@/lib/theme/appBg";
import { scaledStyles } from "@/lib/ui/compact";

const C = {
  sheet: "#1F1F20",
  border: "#2E2E30",
  white: "#FFFFFF",
  gray1: "#C8C8CC",
  gray2: "#8A8A90",
  black: "#000000",
  red: "#FF3B5C",
  surface3: "#2A2A2C",
};

/** Mounted once at the app root. Renders styled alerts triggered via `showAlert(...)`. */
export function AppAlertHost() {
  const palette = usePalette();
  const visible = useAlertStore((s) => s.visible);
  const title = useAlertStore((s) => s.title);
  const body = useAlertStore((s) => s.body);
  const buttons = useAlertStore((s) => s.buttons);
  const dismiss = useAlertStore((s) => s.dismiss);

  const fallback: AlertButton[] = [{ text: "OK", style: "default" }];
  const list = buttons && buttons.length > 0 ? buttons : fallback;

  const handlePress = (btn: AlertButton) => {
    haptic("button");
    dismiss();
    btn.onPress?.();
  };

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      <Animated.View
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(150)}
        style={styles.backdrop}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
      </Animated.View>
      <View style={styles.center} pointerEvents="box-none">
        <Animated.View
          entering={ZoomIn.duration(200)}
          exiting={ZoomOut.duration(150)}
          style={[styles.dialog, { backgroundColor: palette.s1 }]}
        >
          {title ? <Text style={styles.title}>{title}</Text> : null}
          {body ? <Text style={styles.body}>{body}</Text> : null}
          <View
            style={[
              list.length > 2
                ? styles.actionsStacked
                : list.length === 2
                ? styles.actionsTwo
                : styles.actionsOne,
            ]}
          >
            {list.map((btn, idx) => {
              const isPrimary = btn.style === "default" || btn.style === undefined;
              const isDestructive = btn.style === "destructive";
              const wStyle =
                list.length > 2
                  ? styles.btnStacked
                  : list.length === 2
                  ? styles.btnHalf
                  : styles.btnFull;
              return (
                <Pressable
                  key={`${btn.text}-${idx}`}
                  onPress={() => handlePress(btn)}
                  style={({ pressed }) => [
                    styles.btn,
                    !isPrimary && !isDestructive && { backgroundColor: palette.s3 },
                    wStyle,
                    isDestructive && styles.btnDestructive,
                    !isPrimary && !isDestructive && styles.btnCancel,
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  {isPrimary && <GradientFill />}
                  <Text
                    style={[
                      styles.btnText,
                      isPrimary && { color: C.black, fontWeight: "700" },
                      isDestructive && { color: C.white, fontWeight: "700" },
                      !isPrimary && !isDestructive && { color: C.gray1, fontWeight: "600" },
                    ]}
                  >
                    {btn.text}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = scaledStyles({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  dialog: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: C.sheet,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    paddingTop: 22,
    paddingHorizontal: 22,
    paddingBottom: 16,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    color: C.white,
    marginBottom: 8,
    letterSpacing: -0.2,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    color: C.gray1,
    marginBottom: 18,
  },
  actionsOne: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 4,
  },
  actionsTwo: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  actionsStacked: {
    flexDirection: "column",
    marginTop: 4,
    gap: 8,
  },
  btn: {
    height: 44,
    borderRadius: 9999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
    overflow: "hidden",
  },
  btnFull: { width: "100%" },
  btnHalf: { width: "48%" },
  btnStacked: { width: "100%" },
  btnCancel: {
    backgroundColor: C.surface3,
  },
  btnDestructive: {
    backgroundColor: C.red,
  },
  btnText: {
    fontSize: 14,
    letterSpacing: -0.1,
    textAlign: "center",
  },
});
