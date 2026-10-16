import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
/**
 * NUR wegen der Nebenwirkung: Das Modul meldet beim Laden den Handler an, der
 * bestimmt, wie eine Meldung behandelt wird, solange die App im VORDERGRUND
 * ist — ohne ihn zeigt Android dort gar nichts an.
 *
 * Bisher kam er nur mit, weil der Ergebnis-Bildschirm zufällig aus demselben
 * Modul importiert. Das ist keine Zusicherung: Wer dort den Import umbaut,
 * nimmt lautlos die Vordergrund-Anzeige mit. Hier steht er ausdrücklich.
 */
import { openAlertRoute } from "@/lib/nav/openAlertRoute";
import { deleteAlertOnServer } from "@/lib/notifications/alertToggle";
import { ackNotification, ensurePushToken, restorePushToken, syncDeviceLocale } from "@/lib/notifications/push";
import { catchUpFiredAlerts, syncPriceAlerts } from "@/lib/notifications/syncAlerts";
import { priceAlertKey, useSearchStore } from "@/stores/searchStore";
import type { AlertHit } from "@/types/saved";

/**
 * Ein Tipp auf eine Preis-Alarm-Meldung öffnet die zugehörige Suche.
 *
 * Ohne diese Komponente kommt die Meldung an, ist aber eine Sackgasse: Man
 * tippt darauf, die App geht auf, und man steht im Landingscreen — und müsste
 * die Strecke, die einem gerade gemeldet wurde, von Hand nachbauen. Genau diese
 * Strecke steht in der Nutzlast, die der Server mitschickt.
 *
 * ZWEI Wege hinein, und beide sind nötig:
 *
 *  • Die App LÄUFT: `addNotificationResponseReceivedListener` feuert beim Tipp.
 *  • Die App war TOT: Dann gab es beim Tipp niemanden, der zuhört. Der letzte
 *    Tipp lässt sich einmalig nachlesen (`getLastNotificationResponseAsync`) —
 *    ohne das wäre der häufigste Fall überhaupt (Meldung kommt an, das Handy
 *    liegt weg, später tippt man darauf) der einzige, der nicht funktioniert.
 *
 * Rendert nichts. Sie hängt am Wurzel-Layout, weil sie den Ergebnis-Bildschirm
 * öffnet und der ebenfalls dort hängt.
 */

interface AlertPayload {
  type?: string;
  mode?: string;
  origin?: string;
  destination?: string;
  originLabel?: string;
  destLabel?: string;
  departDate?: string;
  returnDate?: string;
  passengers?: string;
  travelClass?: string;
  currency?: string;
  /** Der gefundene Preis und die Änderung in Prozent — siehe Server. */
  price?: string;
  pct?: string;
}

/**
 * Eine eingetroffene Meldung in die Liste unter der Glocke schreiben.
 *
 * WOZU: Ohne das wäre eine Meldung nach dem Wegwischen aus der Leiste
 * verschwunden — und mit ihr die Zahl, wegen der sie kam. Wer nachts eine
 * Meldung sieht und morgens nachsehen will, was der Preis war, fände nichts.
 *
 * BEIDE Wege schreiben: Empfang UND Tipp. Läuft die App, feuert der Empfang;
 * war sie tot, gibt es nur den Tipp. Ein Eintrag entstünde sonst je nach
 * Zustand der App mal und mal nicht — und der Speicher ersetzt gleiche
 * Strecken, doppelt kann es also nicht werden.
 */
function recordHit(p: AlertPayload): void {
  if (!p.mode || !p.origin || !p.destination || !p.departDate) return;
  const price = Number(p.price);
  // Ohne Preis kein Eintrag: Eine Zeile, die „0 EUR" behauptet, wäre schlimmer
  // als keine. Ältere Server schicken das Feld nicht mit.
  if (!Number.isFinite(price) || price <= 0) return;
  const pct = Number(p.pct);

  /**
   * ERST WARTEN, BIS DIE PLATTE GELESEN IST — und zwar für DIESE GANZE Funktion.
   *
   * Der Riegel im Speicher (`addAlertHit`) allein reicht hier nicht, und der
   * Unterschied ist kein Detail: Diese Funktion LIEST die Alarmliste ein paar
   * Zeilen weiter unten selbst, um den erledigten Alarm zu finden. Vor der
   * Hydrierung ist sie leer — `fired` bliebe also `undefined`, und der Alarm
   * würde zwar lokal entfernt, bliebe auf dem Server aber aktiv und meldete
   * sich alle zwölf Stunden weiter. Das ist genau die Falle, die unten
   * beschrieben steht, nur von der anderen Seite.
   *
   * Deshalb der Riegel am EINGANG: Er deckt das Nachschlagen, das Schreiben und
   * den Server-Aufruf in einem ab. Der Riegel im Speicher bleibt trotzdem
   * stehen — er schützt jeden künftigen Aufrufer, der diesen hier nicht kennt.
   *
   * WARUM das überhaupt passiert: Der häufigste Fall ist der Tipp auf eine
   * Meldung bei GESCHLOSSENER App. Sie startet kalt, und die Persistenz liest
   * in dieser Phase den gesamten gespeicherten Block. Wer dazwischen schreibt,
   * dessen Schreibvorgang wird vom Zusammenführen überrollt: Der gespeicherte
   * Stand gewinnt Feld für Feld und wird ERSETZEND gesetzt.
   */
  if (!useSearchStore.persist.hasHydrated()) {
    useSearchStore.persist.onFinishHydration(() => recordHit(p));
    return;
  }

  /**
   * Den erledigten Alarm HERAUSSUCHEN, bevor der Speicher ihn entfernt.
   *
   * Danach ist er weg, und mit ihm seine Server-Kennung — ohne die ließe er
   * sich dort nicht mehr löschen. Ein Alarm, der in der App verschwindet und
   * auf dem Server bleibt, meldet sich alle zwölf Stunden weiter, und niemand
   * kann ihn noch finden. Genau diese Falle ist im Projekt schon einmal
   * zugeschnappt.
   */
  const st = useSearchStore.getState();
  const key = priceAlertKey({
    mode: p.mode,
    origin: p.origin,
    destination: p.destination,
    departDate: p.departDate,
    returnDate: p.returnDate,
    passengers: Number(p.passengers ?? "1") || 1,
    travelClass: p.travelClass ?? "",
    currency: p.currency ?? "EUR",
  });
  const fired = st.priceAlerts.find((a) => priceAlertKey(a) === key);

  st.addAlertHit({
    mode: p.mode as AlertHit["mode"],
    origin: p.origin,
    destination: p.destination,
    originLabel: p.originLabel ?? p.origin,
    destLabel: p.destLabel ?? p.destination,
    departDate: p.departDate,
    ...(p.returnDate ? { returnDate: p.returnDate } : {}),
    passengers: Number(p.passengers ?? "1") || 1,
    travelClass: p.travelClass ?? "",
    currency: p.currency ?? "EUR",
    price,
    pct: Number.isFinite(pct) ? pct : 0,
    receivedAt: new Date().toISOString(),
  });

  /**
   * Und auf dem Server nachziehen — GELÖSCHT, nicht pausiert.
   *
   * Hier stand `setAlertActiveOnServer(fired, false)`, und das war richtig,
   * solange Ausschalten Löschen bedeutete. Seit der Schalter nur noch pausiert,
   * wäre es der schlimmste Ausgang: Der Alarm verschwindet hier aus der Liste
   * (er hat ja ausgelöst und steht jetzt unter der Glocke), und mit ihm seine
   * Server-Kennung — die Zeile bliebe pausiert für immer in der Datenbank, von
   * der App aus weder sichtbar noch erreichbar.
   *
   * Ein ausgelöster Alarm ist erledigt, und Erledigtes wird gelöscht — dieselbe
   * Entscheidung wie im Nachhol-Weg (`catchUpFiredAlerts`).
   *
   * Bewusst OHNE darauf zu warten: Das läuft im Empfangs- oder Tipp-Weg einer
   * Meldung; dort auf eine Netzantwort zu warten hieße, die Öffnung der
   * Ergebnisliste dahinter anzustellen. Scheitert es, bleibt der Alarm auf dem
   * Server — dann holt ihn der nächste App-Start nach (`catchUpFiredAlerts`
   * löscht ihn dort). Es heilt sich also selbst, statt dauerhaft schiefzustehen.
   */
  if (fired) void deleteAlertOnServer(fired);
}


/**
 * Was beim ANTIPPEN einer Alarm-Meldung passieren muss — an EINER Stelle.
 *
 * Es gibt dafür ZWEI Eingänge, und das ist der ganze Grund für diese Funktion:
 * Läuft die App, meldet sich `addNotificationResponseReceivedListener`. War sie
 * tot, gibt es beim Start stattdessen `getLastNotificationResponseAsync` — ein
 * völlig anderer Weg, derselbe Vorgang.
 *
 * Genau daran ist es schiefgegangen: Das Aufzeichnen stand im Zuhörer, im
 * Kaltstart-Weg fehlte es. Wer eine Meldung bei geschlossener App antippte —
 * also im Normalfall — bekam die Ergebnisliste zu sehen, aber unter der Glocke
 * blieb es leer und der Alarm stand weiter unter „Gespeichert". Von außen sah
 * das aus, als griffe die Funktion gar nicht.
 *
 * Drei Dinge gehören zusammen, und sie stehen deshalb zusammen: aufzeichnen,
 * quittieren, öffnen. Ein dritter Eingang kann jetzt keinen davon mehr
 * vergessen.
 */
function handleAlertTap(data: AlertPayload): void {
  recordHit(data);
  /**
   * Die Kennung MUSS erst da sein, sonst geht die Bestätigung ins Leere.
   *
   * Nach einem Kaltstart über einen Tipp hat noch niemand `ensurePushToken`
   * gerufen — der Zwischenspeicher ist leer, und `ackNotification` steigt still
   * aus. Die Erlaubnis liegt in diesem Fall zwangsläufig vor (es kam ja eine
   * Meldung an), es wird hier also nichts erfragt, was der Nutzer nicht schon
   * erteilt hat.
   */
  void ensurePushToken().then((r) => {
    if (r.ok) ackNotification("tapped");
  });
  /**
   * Der Öffner liegt in `lib/nav/openAlertRoute` — nicht mehr hier.
   *
   * Seit die Karte unter der Glocke dieselbe Suche öffnen kann, gibt es zwei
   * Aufrufer. Zwei Fassungen davon hießen: Der eine Weg öffnet eine Suche für
   * eine Person, der andere für vier — und die Preise in der Liste sagten
   * jeweils etwas anderes.
   */
  openAlertRoute({
    mode: data.mode ?? "",
    origin: data.origin ?? "",
    destination: data.destination ?? "",
    originLabel: data.originLabel,
    destLabel: data.destLabel,
    departDate: data.departDate ?? "",
    returnDate: data.returnDate,
    passengers: data.passengers,
    travelClass: data.travelClass,
    currency: data.currency,
  });
}

export function PriceAlertRouter() {
  /**
   * Der Kaltstart-Fall darf GENAU EINMAL laufen.
   *
   * `getLastNotificationResponseAsync` liefert denselben Tipp auch beim nächsten
   * Aufruf noch — ohne Riegel öffnete sich die Suche bei jedem Aufbau dieser
   * Komponente erneut, und bei einem Wechsel in den Vordergrund käme sie
   * ungefragt wieder.
   */
  const coldHandled = useRef(false);

  /**
   * Sprachwechsel im Betrieb dem Server melden.
   *
   * Den Titel der Meldung schreibt der Server, und er kennt die Sprache nur aus
   * der Anmeldung des Geräts. Die läuft beim Start — wer danach umstellt, bekäme
   * seine Meldungen sonst bis zum nächsten Start in der alten Sprache.
   *
   * Als Abonnement am Store statt als Abhängigkeit eines Effekts: So läuft
   * nichts beim ersten Aufbau, wo die Anmeldung ohnehin gerade stattfindet.
   */
  useEffect(() => {
    // Der Store trägt kein `subscribeWithSelector` — der Vergleich steht
    // deshalb hier. Das ist ein Zeichenketten-Vergleich pro Store-Änderung,
    // also nichts, was ins Gewicht fällt.
    let last = useSearchStore.getState().locale;
    return useSearchStore.subscribe((st) => {
      if (st.locale === last) return;
      last = st.locale;
      syncDeviceLocale();
    });
  }, []);

  useEffect(() => {
    let alive = true;

    /**
     * Die Kennung beim Start wiederherstellen — OHNE Dialog.
     *
     * `ackNotification` liest einen Zwischenspeicher, und der ist nach jedem
     * App-Start leer. Ohne diese Zeile stiege die Empfangs-Bestätigung fast
     * immer still aus: Eine Meldung käme an, die App bekäme sie mit, und
     * niemand erführe davon. `restorePushToken` fragt nichts — es holt die
     * Kennung nur, wenn die Erlaubnis schon erteilt ist, und tut sonst nichts.
     */
    void restorePushToken();

    /**
     * Gemerkte Alarme beim Server nachtragen — nicht sofort.
     *
     * Push-Kennungen wechseln, und die Alarme auf dem Server hängen daran. Ohne
     * diesen Abgleich stünde ein Alarm nach einer Neuinstallation weiter in der
     * App, wäre auf dem Server aber fort — er meldete sich nie wieder, und
     * niemand könnte den Grund sehen.
     *
     * Vier Sekunden Abstand: Es ist eine Reihe von Netz-Anfragen, und der
     * App-Start ist der teuerste Moment der ganzen Sitzung. Eilig ist es nicht
     * — der Alarm wird erst geprüft, wenn irgendwann jemand diese Strecke sucht.
     */
    const syncTimer = setTimeout(() => {
      if (!alive) return;
      /**
       * ERST ABHOLEN, DANN NACHTRAGEN — und diese Reihenfolge ist zwingend.
       *
       * `catchUpFiredAlerts` erkennt ausgelöste Alarme daran, dass auf dem
       * Server `lastNotifiedAt` gesetzt ist. `syncPriceAlerts` legt die lokal
       * gemerkten Alarme erneut an — und der Server SETZT DABEI `lastNotifiedAt`
       * ZURÜCK, mit gutem Grund: Ein neu gesetzter Alarm soll nicht schweigen,
       * weil der alte vor zwei Stunden gemeldet hat.
       *
       * Andersherum gerufen löschte der Abgleich also genau den Beweis, den das
       * Abholen eine Zehntelsekunde später gesucht hätte. Das wäre ein Fehler
       * gewesen, den man nie sieht: Es kommt einfach nichts an, so wie bisher.
       *
       * Und es geht auf: Was das Abholen findet, entfernt es lokal UND auf dem
       * Server. Der Abgleich danach sieht es gar nicht mehr und legt es nicht
       * wieder an.
       *
       * Das Abholen ist der Weg für den Fall, den der Tipp NICHT abdeckt: Die
       * Meldung kam bei toter App an, und der Nutzer öffnet die App danach ganz
       * normal statt über die Meldung. Dann läuft kein Tipp-Weg, und ohne diese
       * Zeile erführe die App nie davon.
       */
      void catchUpFiredAlerts().then(() => {
        if (alive) void syncPriceAlerts();
      });
    }, 4000);

    /**
     * Der Kaltstart-Tipp — bewusst mit Verzögerung.
     *
     * Beim Start läuft der Splash, und darunter baut sich der Landingscreen auf.
     * Die Bewegung der Ergebnisliste in diese Phase zu legen hieße, sie gegen
     * den schwersten Aufbau der App laufen zu lassen. Eine knappe Sekunde
     * später steht alles, und die Fahrt hat den Strang für sich.
     */
    const cold = setTimeout(() => {
      if (!alive || coldHandled.current) return;
      coldHandled.current = true;
      void Notifications.getLastNotificationResponseAsync().then((res) => {
        if (!alive || !res) return;
        const data = res.notification.request.content.data as AlertPayload | undefined;
        if (data?.type !== "priceAlert") return;
        // Derselbe Vorgang wie beim Zuhörer unten — siehe `handleAlertTap`.
        handleAlertTap(data);
      });
    }, 900);

    /**
     * ANKUNFT bestätigen — nicht nur den Tipp.
     *
     * Das ist der einzige Weg, auf dem von außen nachprüfbar wird, ob eine
     * Meldung das Gerät wirklich erreicht hat: Firebase weiß es selbst nicht,
     * es kennt nur seine Warteschlange. Feuert nur, solange die App läuft — für
     * eine getötete App liefert Android die Meldung ohne JS aus, dann bleibt
     * der Tipp der Nachweis.
     */
    const arrived = Notifications.addNotificationReceivedListener((n) => {
      const data = n.request.content.data as AlertPayload | undefined;
      if (data?.type !== "priceAlert") return;
      /**
       * Zweiter Riegel für den Zwischenspeicher.
       *
       * Der Start oben stellt ihn her, aber eine Meldung kann eintreffen,
       * bevor das durch ist — es ist ein asynchroner Aufruf. Hier noch einmal,
       * damit die Bestätigung in KEINEM Fall ins Leere läuft. Ein Dialog kann
       * dabei nicht entstehen: Wer eine Meldung empfängt, hat die Erlaubnis
       * zwangsläufig erteilt.
       */
      recordHit(data);
      void restorePushToken().then(() => ackNotification("received"));
    });

    const sub = Notifications.addNotificationResponseReceivedListener((res) => {
      // Ab hier läuft die App — der Kaltstart-Weg darf nicht mehr greifen,
      // sonst öffnete derselbe Tipp die Suche zweimal.
      coldHandled.current = true;
      const data = res.notification.request.content.data as AlertPayload | undefined;
      if (data?.type !== "priceAlert") return;
      handleAlertTap(data);
    });

    return () => {
      alive = false;
      clearTimeout(cold);
      clearTimeout(syncTimer);
      arrived.remove();
      sub.remove();
    };
  }, []);

  return null;
}
