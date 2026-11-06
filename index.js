// MESSSONDE (vorübergehend): Der Devtools-Haken muss stehen, bevor React lädt —
// deshalb dieser eigene Einstieg statt direkt `expo-router/entry`. Nach der
// Auswertung wieder auf "main": "expo-router/entry" zurück und diese Datei weg
// (siehe lib/perf/transitionProbe.ts).
import "./lib/perf/installCommitHook";
import "expo-router/entry";
