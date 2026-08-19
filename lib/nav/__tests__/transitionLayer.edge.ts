/**
 * Ausführbare Randfall-Prüfung für die Textur-Verwaltung.
 *
 * Aufruf: `npx tsx --tsconfig tsconfig.json lib/nav/__tests__/transitionLayer.edge.ts`
 * (kein Testlauf-Rahmenwerk im Projekt — bewusst ein eigenständiges Skript,
 * damit es ohne Gerät und ohne zusätzliche Abhängigkeit läuft).
 *
 * Warum GENAU diese Module: Sie entscheiden, wann eine bildschirmfüllende
 * GPU-Ebene gehalten und wann sie freigegeben wird. Beide Fehler, die in diesem
 * Durchgang echte Ruckler erzeugt haben, saßen hier — eine Ebene, die mitten in
 * der Fahrt abgerissen wurde, und eine, die für immer hängenblieb.
 */
import { prepareLayer, holdLayer, rearmLayer, releaseLayer, subscribeLayer, layerGeneration } from "@/lib/nav/transitionLayer";
import { setSheetMoving, isSheetMoving } from "@/lib/nav/searchHandoff";
import { markTransitionBusy, isTransitionBusy } from "@/lib/nav/transitionBusy";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FEHLT ${name}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Zustand je Schlüssel mitschreiben
const state: Record<string, boolean> = {};
subscribeLayer("pickerLocation", (v) => { state.loc = v; });
subscribeLayer("pickerDate", (v) => { state.date = v; });

async function main() {
  console.log("\n1) Zwei Blätter gleichzeitig — kein Übersprechen");
  setSheetMoving(true, "pickerLocation");
  setSheetMoving(true, "pickerDate");
  check("beide angemeldet → fährt", isSheetMoving());
  setSheetMoving(false, "pickerLocation");
  check("einer fertig → fährt IMMER NOCH (der andere läuft)", isSheetMoving());
  setSheetMoving(false, "pickerDate");
  check("beide fertig → steht still", !isSheetMoving());

  console.log("\n2) Doppelte Meldung desselben Schlüssels");
  setSheetMoving(true, "pickerLocation");
  setSheetMoving(true, "pickerLocation");
  setSheetMoving(false, "pickerLocation");
  check("zweimal an, einmal ab → steht still (kein Zähler-Leck)", !isSheetMoving());

  console.log("\n3) Ebene wird während einer Fahrt NICHT abgerissen");
  prepareLayer("pickerLocation");
  check("angefordert → Ebene an", state.loc === true);
  setSheetMoving(true, "pickerLocation");
  releaseLayer("pickerLocation");
  check("Freigabe während der Fahrt → Ebene bleibt", state.loc === true);

  console.log("\n4) …aber sie bleibt nicht ewig hängen");
  // Meldung bleibt absichtlich stehen (der Fall „Rückruf lief nie")
  releaseLayer("pickerLocation");
  check("zweite Freigabe trotz stehender Meldung → Ebene weg", state.loc === false);
  setSheetMoving(false, "pickerLocation");

  console.log("\n5) Neue Anforderung setzt den Aufschub zurück");
  prepareLayer("pickerLocation");
  setSheetMoving(true, "pickerLocation");
  releaseLayer("pickerLocation");
  check("erste Freigabe → gehalten", state.loc === true);
  prepareLayer("pickerLocation");           // neue Anforderung
  releaseLayer("pickerLocation");
  check("nach neuer Anforderung wieder EIN Aufschub → gehalten", state.loc === true);
  setSheetMoving(false, "pickerLocation");
  releaseLayer("pickerLocation");
  check("ohne Fahrt → sofort weg", state.loc === false);

  console.log("\n6) Generation: alte Freigabe darf eine neue Ebene nicht abräumen");
  prepareLayer("pickerDate");
  const genAlt = layerGeneration("pickerDate");
  releaseLayer("pickerDate");                       // Ebene weg
  prepareLayer("pickerDate");                       // NEUE Anforderung
  releaseLayer("pickerDate", genAlt);               // verspätete Freigabe der alten
  check("verspätete Freigabe greift nicht", state.date === true);
  releaseLayer("pickerDate");
  check("aktuelle Freigabe greift", state.date === false);

  console.log("\n7) Bewegungs-Sperre für aufgeschobene Arbeit");
  markTransitionBusy(120);
  check("direkt danach → beschäftigt", isTransitionBusy());
  await sleep(220);
  check("nach Ablauf → frei", !isTransitionBusy());

  console.log("\n8) `holdLayer` hält NUR eine bestehende Ebene (Vertrag)");
  releaseLayer("pickerLocation");
  holdLayer("pickerLocation");
  check("nicht angefordert → bleibt aus (legt nichts an)", state.loc === false);
  prepareLayer("pickerLocation");
  holdLayer("pickerLocation");
  await sleep(1600);                                  // Frist ist 1400ms
  check("angefordert + gehalten → überlebt die Frist", state.loc === true);
  releaseLayer("pickerLocation");
  check("ausdrückliche Freigabe → weg", state.loc === false);

  console.log("\n9) `rearmLayer` verlängert mit Ablaufdatum");
  rearmLayer("pickerLocation");
  check("nicht angefordert → legt nichts an", state.loc === false);
  prepareLayer("pickerLocation");
  rearmLayer("pickerLocation");
  check("angefordert → an", state.loc === true);
  await sleep(1600);
  check("nach der Frist → von selbst weg", state.loc === false);

  console.log(`\nErgebnis: ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
