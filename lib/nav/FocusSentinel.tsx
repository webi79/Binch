import { useEffect, useRef } from "react";
import { useIsFocused } from "@react-navigation/native";

/**
 * Fokus-Verlust beobachten, OHNE den Screen daran zu hängen.
 *
 * `useIsFocused()` an der Screen-Wurzel kostet mehr, als es aussieht: Der Hook
 * rendert seine Komponente bei jedem Fokus-Wechsel neu — also ZWEIMAL pro
 * Tab-Wechsel (einmal beim Verlassen, einmal beim Betreten). Steht er in einer
 * großen Screen-Funktion, rekonziliert damit jedes Mal der komplette Baum;
 * memoisierte Kinder bailen zwar raus, alles andere (bei Settings u.a. die
 * nicht memoisierten Hub-Kacheln mit ihren SVG-Illustrationen) aber nicht.
 * Genau diese Renderpässe fallen in den Frame, der den Tab-Wechsel trägt.
 *
 * Als eigene Komponente gerendert bleibt der Neu-Render auf diese eine Zeile
 * beschränkt — sie gibt `null` zurück, hat also keinen Baum.
 *
 * Bewusst der echte VERLUST (war fokussiert → ist es nicht mehr), nicht bloß
 * „nicht fokussiert": Sonst würde der Effekt auch beim Mount feuern, während
 * der Screen noch nie sichtbar war.
 */
export function OnFocusLost({ run }: { run: () => void }) {
  const focused = useIsFocused();
  const runRef = useRef(run);
  runRef.current = run;
  const wasFocused = useRef(focused);

  useEffect(() => {
    const lost = wasFocused.current && !focused;
    wasFocused.current = focused;
    if (lost) runRef.current();
  }, [focused]);

  return null;
}
