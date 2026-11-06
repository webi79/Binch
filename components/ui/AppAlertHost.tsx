import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { TITLE_GAP, GROUP_GAP } from "@/lib/theme/spacing";
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut } from "react-native-reanimated";
import { CircleAlert, Info } from "lucide-react-native";
import { StateArt } from "@/components/ui/StateArt";
import { useAlertStore, type AlertButton } from "@/lib/alert";
import { haptic } from "@/lib/haptics";
import { useT } from "@/lib/i18n/useT";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { ms, scaledStyles } from "@/lib/ui/compact";

const C = {
  white: "#F4F4F5",
  gray1: "#C8C8CC",
  /** Weicher Rand wie an den beiden anderen Dialogen — kein harter Kasten. */
  border: "rgba(255,255,255,0.08)",
  scrim: "rgba(0,0,0,0.55)",
  /** Destruktiv-Rot, derselbe Wert wie am Papierkorb der Recent-Karte. */
  danger: "#E5484D",
};

/**
 * Größe der Zeichnung im Dialog — durch `ms()` gedreht, NICHT roh: Sie ist
 * eine Eigenschaft, kein Stilwert, `scaledStyles` erfasst sie also nicht. Roh
 * behielte sie auf einem kurzen Gerät als einzige ihre volle Größe.
 */
const ART_SIZE = ms(104);

/**
 * Einmal an der Wurzel gehängt, zeigt alles an, was über `showAlert(...)` kommt.
 *
 * Das Aussehen ist NICHT hier erfunden, sondern von den beiden handgebauten
 * Dialogen der App übernommen — [ClearSearchHistoryAlert] und
 * [ConnectionNotFoundModal]. Beide sagen dasselbe:
 *
 *   Karte auf `s2`, Radius 28, weicher Rand · oben ein Symbol im Kreis ·
 *   Titel 21/800 mittig · Text 14/21 mittig · darunter GESTAPELTE Knöpfe:
 *   die Aktion als Akzent-Knopf (Radius 16), „Abbrechen" als reiner Textknopf.
 *
 * Vorher war dieser Host eine eigene Sprache: 20er Radius mit hartem Rand,
 * Titel 17, Kapsel-Knöpfe nebeneinander auf halber Breite, kein Symbol. Für
 * sich genommen sauber, neben den anderen beiden aber sichtbar ein Fremdkörper
 * — und da hier die Mehrheit aller Meldungen durchläuft, hat ausgerechnet die
 * generische Stelle das Bild bestimmt.
 *
 * Zwei Regeln kommen mit, die man beim Lesen leicht für Fehler hält:
 *
 *  - **Der bestätigende Knopf ist auch beim Löschen der Akzent-Knopf, nicht
 *    rot.** Das Rot steckt im Symbolkreis. Genau so macht es der
 *    Verlauf-löschen-Dialog; zwei verschiedene Antworten auf dieselbe Frage
 *    wären hier das eigentliche Problem.
 *  - **Die Aktion steht OBEN, „Abbrechen" darunter** — unabhängig von der
 *    Reihenfolge im Aufruf. Die Aufrufe folgen der iOS-Sitte und stellen
 *    „Abbrechen" nach vorn; gestapelt gehört die Aktion aber an die betonte
 *    Stelle.
 *
 * Das Symbol oben leitet der Host selbst her. Nur wo das zu wenig ist, sagt es
 * der Aufruf über `showAlert(..., "logout" | "delete")`: Dann zeichnet sich
 * dort eine Strichzeichnung statt des Zeichens (Tür mit Pfeil, Eimer; vorher ein
 * trauriger Bo) — beim Abmelden sah das rote Ausrufezeichen nach einem Unglück
 * aus statt nach „schade, dass du gehst". Alles andere an der
 * Karte bleibt gleich; es ist bewusst KEIN eigener Dialog geworden, sondern
 * dieselbe Karte mit einem anderen Bild.
 */
export function AppAlertHost() {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  const visible = useAlertStore((s) => s.visible);
  const title = useAlertStore((s) => s.title);
  const body = useAlertStore((s) => s.body);
  const buttons = useAlertStore((s) => s.buttons);
  const art = useAlertStore((s) => s.art);
  const dismiss = useAlertStore((s) => s.dismiss);

  const fallback: AlertButton[] = [{ text: "OK", style: "default" }];
  const list = buttons && buttons.length > 0 ? buttons : fallback;

  /** Aktion(en) zuerst, „Abbrechen" ans Ende — siehe Kopf. */
  const ordered = [
    ...list.filter((b) => b.style !== "cancel"),
    ...list.filter((b) => b.style === "cancel"),
  ];

  /** Rot statt Akzent im Symbolkreis, sobald irgendein Knopf löscht. */
  const isDestructive = list.some((b) => b.style === "destructive");

  const handlePress = (btn: AlertButton) => {
    haptic(btn.style === "destructive" ? "important" : "button");
    dismiss();
    btn.onPress?.();
  };

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      <Animated.View
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(140)}
        style={styles.scrim}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          onPress={dismiss}
        />
        <Animated.View
          entering={ZoomIn.duration(200)}
          exiting={ZoomOut.duration(140)}
          style={styles.cardWrap}
        >
          {/**
            * Der innere Pressable schluckt Tipper auf die Karte, sonst würde die
            * Verdunkelung darunter schließen.
            *
            * `accessible={false}` ist dabei Pflicht und nicht Kür: `Pressable`
            * setzt die Eigenschaft von sich aus auf wahr, und damit wird die
            * Karte auf iOS zu EINEM Bedienelement — VoiceOver steigt dann nicht
            * mehr zu den Kindern ab, liest die ganze Karte als Knopf mit einem
            * Handler vor, der nichts tut, und erreicht weder „Abmelden" noch
            * „Abbrechen". Der Knopf hier fängt nur Berührungen ab; ein
            * Bedienelement ist er nicht.
            */}
          <Pressable
            style={[styles.card, { backgroundColor: palette.s2 }]}
            onPress={() => {}}
            accessible={false}
          >
            {art ? (
              /* Die Zeichnung zeichnet sich, während der Dialog aufzoomt, und
                 steht dann; das Fenster baut sie beim Schließen mit ab. */
              <View style={styles.artSlot}>
                <StateArt kind={art} size={ART_SIZE} surface={palette.s2} />
              </View>
            ) : (
              <View
                style={[
                  styles.iconCircle,
                  isDestructive ? { backgroundColor: C.danger } : { backgroundColor: accent.subtle },
                ]}
              >
                {isDestructive ? (
                  <CircleAlert size={32} color={C.white} strokeWidth={2.2} />
                ) : (
                  <Info size={32} color={accent.solid} strokeWidth={2.2} />
                )}
              </View>
            )}

            {title ? (
              <Text
                style={[styles.title, !body && styles.titleAlone]}
                maxFontSizeMultiplier={1.4}
              >
                {title}
              </Text>
            ) : null}
            {body ? (
              <Text style={styles.body} maxFontSizeMultiplier={1.5}>
                {body}
              </Text>
            ) : null}

            {ordered.map((btn, idx) => {
              /**
               * Der erste Knopf trägt den Akzent. Nach dem Sortieren oben ist
               * das die Aktion — und wenn ein Aufruf ausschließlich
               * „Abbrechen" anbietet, eben der einzige Weg hinaus.
               */
              const isPrimary = idx === 0;
              const isGhost = !isPrimary && btn.style === "cancel";

              if (isPrimary) {
                return (
                  <View
                    key={`${btn.text}-${idx}`}
                    // Hintergrund am umschließenden View, nicht am Pressable:
                    // Auf Android fällt eine Hintergrundfarbe aus einer
                    // Pressable-Stilfunktion gelegentlich aus.
                    style={[styles.solidBtn, { backgroundColor: accent.solid }]}
                  >
                    <Pressable
                      onPress={() => handlePress(btn)}
                      android_ripple={{ color: "rgba(0,0,0,0.15)" }}
                      style={styles.solidTouch}
                      accessibilityRole="button"
                      accessibilityLabel={btn.text}
                    >
                      <Text style={[styles.solidLabel, { color: accent.textOnSolid }]}>{btn.text}</Text>
                    </Pressable>
                  </View>
                );
              }

              if (isGhost) {
                return (
                  <View key={`${btn.text}-${idx}`} style={styles.ghostBtn}>
                    <Pressable
                      onPress={() => handlePress(btn)}
                      style={styles.ghostTouch}
                      accessibilityRole="button"
                      accessibilityLabel={btn.text}
                    >
                      <Text style={styles.ghostLabel}>{btn.text}</Text>
                    </Pressable>
                  </View>
                );
              }

              /* Dritter Fall, heute von keinem Aufruf genutzt: eine zweite
                 Aktion neben der ersten. Gedeckt statt Akzent — es darf nur
                 einen betonten Knopf geben. */
              return (
                <View key={`${btn.text}-${idx}`} style={[styles.solidBtn, { backgroundColor: palette.s3 }]}>
                  <Pressable
                    onPress={() => handlePress(btn)}
                    android_ripple={{ color: "rgba(255,255,255,0.12)" }}
                    style={styles.solidTouch}
                    accessibilityRole="button"
                    accessibilityLabel={btn.text}
                  >
                    <Text style={[styles.solidLabel, { color: C.white }]}>{btn.text}</Text>
                  </Pressable>
                </View>
              );
            })}
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = scaledStyles({
  scrim: {
    flex: 1,
    backgroundColor: C.scrim,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  cardWrap: { width: "100%", maxWidth: 360 },
  card: {
    borderRadius: 28,
    borderWidth: 1,
    borderColor: C.border,
    paddingTop: 28,
    paddingHorizontal: 24,
    paddingBottom: 16,
    alignItems: "center",
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
    marginBottom: 16,
  },
  /**
   * Die Zeichnung belegt nur noch ihre Tinte (`StateArt`, Ausschnitt) — der
   * Abstand zum Titel ist damit ein echter, sichtbarer: der Gruppen-Abstand.
   * Oben trägt der Innenrand der Karte allein.
   */
  artSlot: { marginBottom: GROUP_GAP },
  title: {
    fontSize: 21,
    fontWeight: "800",
    letterSpacing: -0.6,
    color: C.white,
    textAlign: "center",
    marginBottom: TITLE_GAP,
  },
  /** Ohne Fließtext trägt der Titel dessen Abstand zum ersten Knopf. */
  titleAlone: { marginBottom: GROUP_GAP },
  body: {
    fontSize: 14,
    lineHeight: 21,
    color: C.gray1,
    textAlign: "center",
    paddingHorizontal: 8,
    marginBottom: GROUP_GAP,
  },

  /** Gefüllter Knopf — Maße wie der „Preise vergleichen"-Knopf im Such-Screen. */
  solidBtn: {
    borderRadius: 16,
    alignSelf: "stretch",
    marginTop: 4,
    marginBottom: 4,
    overflow: "hidden",
  },
  solidTouch: {
    paddingVertical: 16,
    paddingHorizontal: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  solidLabel: { fontSize: 17, fontWeight: "700", textAlign: "center" },

  ghostBtn: { alignSelf: "stretch" },
  ghostTouch: { height: 44, alignItems: "center", justifyContent: "center" },
  ghostLabel: { fontSize: 14, fontWeight: "600", color: C.gray1, textAlign: "center" },
});
