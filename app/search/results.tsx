/**
 * Die Ergebnis-ROUTE — nur noch eine Hülle. Gerendert wird hier nichts.
 *
 * Der sichtbare Bildschirm liegt seit dem Umbau in
 * `components/results/ResultsView.tsx` und hängt dauerhaft am Root (siehe
 * app/_layout.tsx). Grund: Als Route entstand er bei JEDEM Antippen neu, und
 * diese Montage läuft auf Fabric auf dem UI-THREAD — demselben, auf dem
 * Reanimated die Bewegung rechnet. Beide konkurrierten um dieselbe Ressource.
 * Daraus folgte beides, was gemeldet wurde: Die Bewegung hängt in den ersten
 * Bildern, und das ERSTE Öffnen fühlt sich anders an als jedes weitere.
 *
 * Der Beleg kam aus der App selbst: Der Übergang im Saved-Tab benutzt dieselbe
 * Kurve, dieselben Texturen und denselben Parallax — nur ohne Aufbau, weil sein
 * Blatt dauerhaft gemountet ist. Und genau der fühlt sich richtig an.
 *
 * WARUM DIE ROUTE TROTZDEM BLEIBT: Sie trägt weiterhin alles Navigatorische —
 * Zurück-Geste, Hardware-Zurück, Verlinkungen von außen (Assistent,
 * Spracheingabe) und vor allem die Karten-Route, die ÜBER den Ergebnissen
 * aufgeht. Nichts davon musste angefasst werden; es wandert ausschließlich das
 * Rendern nach oben.
 */
import { useEffect, useRef } from "react";
import { useLocalSearchParams } from "expo-router";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { runOnJS, withTiming } from "react-native-reanimated";
import { useSearchStore } from "@/stores/searchStore";
import { resultsPush, POP_SPRING } from "@/lib/nav/overlayCover";
import { markTransitionBusy } from "@/lib/nav/transitionBusy";
import { skipNextScreenEntrance } from "@/lib/motion";

export default function ResultsRoute() {
  const navigation = useNavigation();
  const params = useLocalSearchParams<Record<string, string>>();

  // Parameter in den Store spiegeln — daraus rendert die Root-Komponente.
  // `router.setParams` (Richtungstausch) laeuft damit weiterhin ueber die Route
  // und kommt hier automatisch an.
  const setResultsParams = useSearchStore((s) => s.setResultsParams);
  const json = JSON.stringify(params ?? {});
  useEffect(() => {
    setResultsParams(JSON.parse(json) as Record<string, string>);
  }, [json, setResultsParams]);

  // Beim Verlassen aufraeumen: Der Baum oben bleibt stehen, zeigt sich aber nur,
  // solange Parameter anliegen.
  const ownJsonRef = useRef(json);
  ownJsonRef.current = json;
  useEffect(
    () => () => {
      skipNextScreenEntrance();
      // NUR aufräumen, wenn oben noch UNSERE Suche steht.
      //
      // Der Wettlauf entsteht erst durch den Umbau: Während diese Route
      // hinausfährt, ist der Landingscreen bereits bedienbar. Tippt jemand dort
      // die nächste Reise an, setzt die neue Suche ihre Parameter — und diese
      // Aufräumung hätte sie eine Wimpernschlag später wieder gelöscht. Der
      // Bildschirm wäre kommentarlos leer geblieben.
      const st = useSearchStore.getState();
      if (JSON.stringify(st.resultsParams ?? {}) !== ownJsonRef.current) return;
      st.setResultsParams(null);
      resultsPush.value = 0;
    },
    [],
  );

  /**
   * Zurueckgehen: Default-Pop abfangen, Bewegung rueckwaerts fahren, dann erst
   * wirklich poppen. Die Bewegung gehoert weiterhin dem geteilten Wert — der Baum
   * oben liest ihn. Hier steht nur, WANN sie laeuft und wann die Route geht.
   */
  const closingRef = useRef(false);
  const actionRef = useRef<Parameters<typeof navigation.dispatch>[0] | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const finish = () => {
      const action = actionRef.current;
      if (!action) return;
      actionRef.current = null;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Ein Bild spaeter abraeumen — der Rueckruf der Kurve feuert im LETZTEN
      // Bild der Bewegung, dessen Komposition da noch offen sein kann.
      requestAnimationFrame(() => navigation.dispatch(action));
    };

    const unsub = navigation.addListener("beforeRemove", (e) => {
      if (closingRef.current) return;
      const store = useSearchStore.getState();
      if (store.bypassResultsSlideOut) {
        store.setBypassResultsSlideOut(false);
        return;
      }
      e.preventDefault();
      closingRef.current = true;
      actionRef.current = e.data.action;
      // KEIN Ebenen-Aufbau hier. Er stand unmittelbar vor dem Start der
      // Rückfahrt — und 66ms Aufbau passen nicht in ein Fenster von einem Bild.
      // Genau derselbe Fehler wie auf dem Hinweg, nur andersherum.
      /**
       * Die Rückfahrt ANMELDEN — hier fehlte es.
       *
       * `isTransitionBusy()` war damit während dieser 380ms falsch, und daran
       * hängen fünf Verbraucher, die dann hineinlaufen dürfen: die Persistenz
       * des Speichers (10 bis 30ms Serialisierung), der gemeinsame Sekunden-
       * Takt, und die drei Leerlauf-Aufbauten von Bo und den beiden Wählern.
       *
       * Die liegen bei 4200, 5200 und 6400ms nach dem Start, und genau in
       * diesem Fenster ist man typischerweise das erste Mal in der
       * Ergebnisliste. Trifft ein 300ms-Wiederversuch das Fenster, committet
       * der schwerste Baum der App mitten in der Rückfahrt — einmal pro
       * App-Lauf, rein zeitabhängig. Also genau ein „vereinzelter Aussetzer".
       */
      markTransitionBusy(POP_SPRING.duration);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(finish, POP_SPRING.duration + 300);
      requestAnimationFrame(() => {
        resultsPush.value = withTiming(0, POP_SPRING, (finished?: boolean) => {
          "worklet";
          if (finished) runOnJS(finish)();
        });
      });
    });
    return () => {
      unsub();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [navigation]);

  /**
   * Stapel auf [results] reduzieren — vor dem Push aus dem Home-Tab landet
   * expo-router temporaer bei `[index, results]`. `key` MITGEBEN, sonst vergibt
   * react-navigation beim Rehydrieren einen neuen und baut die Route neu auf.
   */
  useEffect(() => {
    const state = navigation.getState();
    if (!state || state.routes.length <= 1) return;
    const current = state.routes[state.index];
    if (!current) return;
    navigation.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [
          {
            key: current.key,
            name: current.name,
            params: current.params as object | undefined,
          },
        ],
      }),
    );
  }, [navigation]);

  return null;
}
