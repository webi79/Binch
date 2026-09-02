import { useCallback, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Minus, Plus } from "lucide-react-native";
import { SheetModal } from "@/components/ui/SheetModal";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { usePalette } from "@/lib/theme/appBg";
import { useAccent } from "@/lib/theme/accent";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { scaledStyles } from "@/lib/ui/compact";

/**
 * Reisende und Klasse — die beiden Blätter über dem Such-Knopf.
 *
 * Aufbau je Blatt: Titel, die Auswahl, unten „Zurücksetzen" und „Übernehmen".
 * Bewegung und Wisch-Geste kommen vollständig aus `SheetModal` und sind damit
 * dieselben wie beim Ticket-Blatt im Saved-Tab.
 *
 * ÜBERNOMMEN wird erst beim Antippen von „Übernehmen": Wer über die
 * Verdunkelung, die Wisch-Geste oder die Zurück-Taste hinausgeht, lässt alles,
 * wie es war. Der Entwurf lebt deshalb IM Blatt — es wird mit dem Fenster
 * aufgebaut und wieder abgebaut, jede Öffnung beginnt also beim aktuellen Stand.
 */

export interface PaxCounts {
  adults: number;
  children: number;
  infants: number;
}

/** Modulweit, nicht als Literal: Der Wert steckt auch im Zurücksetzen des
 *  Formulars, und ein neues Objekt wäre dort jedes Mal ein Render mehr. */
export const DEFAULT_PAX: PaxCounts = { adults: 1, children: 0, infants: 0 };

/**
 * Deckel bei 9 — dieselbe Grenze wie zuvor am einzelnen Zähler, und dieselbe,
 * die der Server prüft (`routes/search.ts`: `passengers` min 1, max 9).
 */
export const MAX_PAX = 9;

export function paxTotal(p: PaxCounts): number {
  return p.adults + p.children + p.infants;
}

export function samePax(a: PaxCounts, b: PaxCounts): boolean {
  return a.adults === b.adults && a.children === b.children && a.infants === b.infants;
}

type PaxKey = keyof PaxCounts;

const PAX_ROWS: { key: PaxKey; label: string; hint: string }[] = [
  { key: "adults", label: "search.pax.adults", hint: "search.pax.adults.hint" },
  { key: "children", label: "search.pax.children", hint: "search.pax.children.hint" },
  { key: "infants", label: "search.pax.infants", hint: "search.pax.infants.hint" },
];

/* ------------------------------------------------------------------ Reisende */

export function TravelersSheet({
  visible,
  value,
  onClose,
  onApply,
}: {
  visible: boolean;
  value: PaxCounts;
  onClose: () => void;
  onApply: (next: PaxCounts) => void;
}) {
  /**
   * Übernommen wird erst, wenn das Blatt UNTEN ist.
   *
   * Sonst fiele der Render des Such-Screens (die Beschriftung des Knopfes
   * ändert sich ja) genau in die 260ms, in denen das Blatt hinausfährt — ein
   * Commit mitten in der Bewegung, für etwas, das hinter der Verdunkelung
   * ohnehin niemand sieht. So laufen Abmelden und Übernehmen im selben Durchgang
   * und ergeben einen einzigen Render.
   */
  const applied = useRef<PaxCounts | null>(null);
  /**
   * Feste Kennung — an `onClose` hängen in der Hülle die Wisch-Geste und der
   * Merker für die Zurück-Taste. Ein Literal wäre bei jedem Render eine neue und
   * würde beides mitten in der laufenden Bewegung neu einrichten.
   */
  const handleClose = useCallback(() => {
    const next = applied.current;
    applied.current = null;
    onClose();
    if (next) onApply(next);
  }, [onClose, onApply]);
  return (
    <SheetModal visible={visible} onClose={handleClose}>
      {(close) => (
        <TravelersBody
          initial={value}
          onApply={(next) => {
            applied.current = next;
            close();
          }}
        />
      )}
    </SheetModal>
  );
}

function TravelersBody({
  initial,
  onApply,
}: {
  initial: PaxCounts;
  onApply: (next: PaxCounts) => void;
}) {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  const [draft, setDraft] = useState<PaxCounts>(initial);
  const total = paxTotal(draft);

  /**
   * Babys auf dem Schoß hängen an den Erwachsenen — eines je Erwachsenem.
   * Deshalb zieht ein Erwachsener weniger die Babys mit nach unten, statt eine
   * Kombination stehen zu lassen, die keine Fluggesellschaft befördert.
   */
  const step = (key: PaxKey, by: 1 | -1) => {
    haptic("button");
    setDraft((p) => {
      const next: PaxCounts = { ...p, [key]: p[key] + by };
      if (next.adults < 1) next.adults = 1;
      if (next.children < 0) next.children = 0;
      if (next.infants < 0) next.infants = 0;
      if (next.infants > next.adults) next.infants = next.adults;
      return next;
    });
  };

  const canDec = (key: PaxKey) => (key === "adults" ? draft.adults > 1 : draft[key] > 0);
  const canInc = (key: PaxKey) => {
    if (total >= MAX_PAX) return false;
    if (key === "infants") return draft.infants < draft.adults;
    return true;
  };

  return (
    <>
      <Text style={styles.title}>{t("search.pax.title")}</Text>
      <Text style={styles.subtitle}>{t("search.pax.subtitle")}</Text>

      <View style={styles.list}>
        {PAX_ROWS.map((row) => {
          const dec = canDec(row.key);
          const inc = canInc(row.key);
          return (
            <View key={row.key} style={[styles.row, { backgroundColor: palette.s2 }]}>
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>{t(row.label)}</Text>
                <Text style={styles.rowHint}>{t(row.hint)}</Text>
              </View>
              <View style={styles.stepper}>
                <RippleTouch
                  borderless
                  disabled={!dec}
                  onPress={() => step(row.key, -1)}
                  accessibilityLabel={`${t("sheet.decrease")} ${t(row.label)}`}
                  style={[
                    styles.stepBtn,
                    { backgroundColor: palette.s3 },
                    !dec && styles.stepBtnOff,
                  ]}
                >
                  <Minus size={16} color="#F4F4F5" strokeWidth={2.6} />
                </RippleTouch>
                <Text style={styles.count}>{draft[row.key]}</Text>
                <RippleTouch
                  borderless
                  disabled={!inc}
                  onPress={() => step(row.key, 1)}
                  accessibilityLabel={`${t("sheet.increase")} ${t(row.label)}`}
                  style={[
                    styles.stepBtn,
                    { backgroundColor: accent.solid },
                    !inc && styles.stepBtnOff,
                  ]}
                >
                  <Plus size={16} color="#000000" strokeWidth={2.6} />
                </RippleTouch>
              </View>
            </View>
          );
        })}
      </View>

      {/* Die Zeile steht IMMER im Baum, beschriftet ist sie nur am Anschlag.
          Ein bedingtes Einhängen würde das Blatt in dem Moment höher machen, in
          dem der Hinweis auftaucht — und ein Blatt, das unten verankert ist,
          wächst nach OBEN: Der ganze Inhalt spränge unter dem Finger weg. */}
      <Text style={styles.limit}>{total >= MAX_PAX ? t("search.pax.limit") : ""}</Text>

      <SheetFooter
        resetDisabled={samePax(draft, DEFAULT_PAX)}
        onReset={() => {
          haptic("button");
          setDraft(DEFAULT_PAX);
        }}
        onApply={() => {
          haptic("button");
          onApply(draft);
        }}
      />
    </>
  );
}

/* -------------------------------------------------------------------- Klasse */

export function ClassSheet({
  visible,
  title,
  options,
  value,
  onClose,
  onApply,
}: {
  visible: boolean;
  /** „Klasse" / „Sitzplatz" / „Kabine" — je nach Verkehrsmittel. */
  title: string;
  /** i18n-Schlüssel der Auswahl, Reihenfolge = Wert. */
  options: string[];
  value: number;
  onClose: () => void;
  onApply: (next: number) => void;
}) {
  /** Wie beim Reisenden-Blatt: erst unten, dann übernehmen. */
  const applied = useRef<number | null>(null);
  /** Feste Kennung, siehe TravelersSheet. */
  const handleClose = useCallback(() => {
    const next = applied.current;
    applied.current = null;
    onClose();
    if (next !== null) onApply(next);
  }, [onClose, onApply]);
  return (
    <SheetModal visible={visible} onClose={handleClose}>
      {(close) => (
        <ClassBody
          title={title}
          options={options}
          initial={value}
          onApply={(next) => {
            applied.current = next;
            close();
          }}
        />
      )}
    </SheetModal>
  );
}

function ClassBody({
  title,
  options,
  initial,
  onApply,
}: {
  title: string;
  options: string[];
  initial: number;
  onApply: (next: number) => void;
}) {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  const [draft, setDraft] = useState(initial);

  return (
    <>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{t("search.class.subtitle")}</Text>

      <View style={styles.list}>
        {options.map((opt, i) => {
          const active = i === draft;
          return (
            <RippleTouch
              key={opt}
              onPress={() => {
                haptic("button");
                setDraft(i);
              }}
              style={[
                styles.optRow,
                { backgroundColor: palette.s2 },
                active && { backgroundColor: accent.subtle, borderColor: accent.border },
              ]}
            >
              {/* Der Ring des NICHT gewählten Punktes steht bewusst auf einem
                  hellen Grau und nicht auf der Rahmenfarbe der App: Die liegt
                  nur zwei Stufen über der Fläche und wäre auf der Zeile kaum zu
                  sehen. */}
              <View
                style={[
                  styles.radio,
                  { borderColor: active ? accent.solid : "#56565C" },
                ]}
              >
                {active ? (
                  <View style={[styles.radioDot, { backgroundColor: accent.solid }]} />
                ) : null}
              </View>
              <Text style={styles.optLabel}>{t(opt)}</Text>
            </RippleTouch>
          );
        })}
      </View>

      <SheetFooter
        resetDisabled={draft === 0}
        onReset={() => {
          haptic("button");
          setDraft(0);
        }}
        onApply={() => {
          haptic("button");
          onApply(draft);
        }}
      />
    </>
  );
}

/* --------------------------------------------------------------------- Fuß */

function SheetFooter({
  resetDisabled,
  onReset,
  onApply,
}: {
  resetDisabled: boolean;
  onReset: () => void;
  onApply: () => void;
}) {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  return (
    <View style={styles.footer}>
      <RippleTouch
        disabled={resetDisabled}
        onPress={onReset}
        style={[
          styles.reset,
          { backgroundColor: palette.s2 },
          resetDisabled && styles.resetOff,
        ]}
      >
        <Text style={styles.resetText}>{t("sheet.reset")}</Text>
      </RippleTouch>
      <RippleTouch
        onPress={onApply}
        rippleColor="rgba(0,0,0,0.32)"
        style={[styles.apply, { backgroundColor: accent.solid }]}
      >
        <Text style={styles.applyText}>{t("sheet.apply")}</Text>
      </RippleTouch>
    </View>
  );
}

const styles = scaledStyles({
  title: { fontSize: 18, fontWeight: "700", color: "#F4F4F5", marginBottom: 6 },
  subtitle: { fontSize: 13, color: "#8E8E93", marginBottom: 16, lineHeight: 18 },

  list: { gap: 8 },

  row: {
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 15, fontWeight: "600", color: "#F4F4F5" },
  rowHint: { fontSize: 12, color: "#8E8E93", marginTop: 2 },

  stepper: { flexDirection: "row", alignItems: "center", gap: 12 },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: 9999,
    alignItems: "center",
    justifyContent: "center",
  },
  /** Am Anschlag: sichtbar, aber erkennbar aus dem Spiel. */
  stepBtnOff: { opacity: 0.35 },
  /** Feste Breite — sonst wandern die Knöpfe, sobald aus 9 eine 10 würde. */
  count: { fontSize: 17, fontWeight: "700", color: "#F4F4F5", minWidth: 18, textAlign: "center" },

  limit: { fontSize: 12, color: "#8E8E93", marginTop: 10, lineHeight: 16, minHeight: 16 },

  optRow: {
    borderRadius: 16,
    minHeight: 54,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    // Unsichtbar reserviert — der ausgewählte Zustand darf die Höhe nicht
    // verändern, sonst springt die Liste beim Umschalten.
    borderWidth: 1,
    borderColor: "transparent",
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  optLabel: { flex: 1, fontSize: 15, fontWeight: "600", color: "#F4F4F5" },

  footer: { flexDirection: "row", gap: 10, marginTop: 14 },
  reset: {
    height: 50,
    paddingHorizontal: 22,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  resetOff: { opacity: 0.4 },
  resetText: { fontSize: 15, fontWeight: "600", color: "#F4F4F5" },
  apply: {
    flex: 1,
    height: 50,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  applyText: { fontSize: 16, fontWeight: "700", color: "#000000" },
});
