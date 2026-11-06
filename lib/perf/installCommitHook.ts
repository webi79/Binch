/**
 * MESSSONDE (vorübergehend): setzt den Devtools-Haken beim Laden dieses
 * Moduls. Steht in `index.js` VOR `expo-router/entry` — der React-Renderer
 * prüft den Haken nur einmal, beim eigenen Laden. Siehe transitionProbe.ts.
 */
import { installCommitHook } from "./transitionProbe";

installCommitHook();
