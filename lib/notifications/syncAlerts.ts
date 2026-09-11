import { createPriceAlert, deletePriceAlert, listPriceAlerts } from "@/lib/api/client";
import { knownPushToken, restorePushToken } from "@/lib/notifications/push";
import { useSearchStore } from "@/stores/searchStore";

/**
 * Die lokal gemerkten Alarme beim Server nachtragen.
 *
 * WOZU: Ein Alarm gehört auf dem Server einer PUSH-KENNUNG, und die wechselt —
 * bei einer Neuinstallation, bei einer Wiederherstellung, und sie wird
 * gelöscht, sobald Firebase sie als tot meldet. Weil die Alarme per Kaskade
 * daran hängen, verschwinden sie mit ihr. Genau das ist heute passiert: Ein
 * Alarm war angelegt, die Kennung fiel weg, und der Alarm war lautlos fort —
 * in der App stand er weiter, auf dem Server nicht mehr.
 *
 * Der lokale Spiegel ist die Rettung: Er überlebt beides. Beim Start wird er
 * einmal gegen den Server gehalten, und was fehlt, wird neu angelegt. Der
 * Endpunkt ist dafür gebaut — er ersetzt einen bestehenden Alarm derselben
 * Strecke, statt einen zweiten daneben zu legen.
 *
 * Läuft still: Ohne Netz oder ohne Erlaubnis passiert nichts, und beim nächsten
 * Start wird es erneut versucht. Ein Fehler hier darf den App-Start nicht
 * behelligen.
 */
export async function syncPriceAlerts(): Promise<void> {
  try {
    const st = useSearchStore.getState();
    const alerts = st.priceAlerts;
    if (alerts.length === 0) return;

    // Ohne Zustellweg ergibt ein Alarm keinen Sinn — und `restorePushToken`
    // fragt nichts nach, es holt die Kennung nur bei erteilter Erlaubnis.
    const token = await restorePushToken();
    if (!token) return;

    for (const a of alerts) {
      try {
        const res = await createPriceAlert(
          {
            pushToken: token,
            mode: a.mode,
            origin: a.origin,
            destination: a.destination,
            originLabel: a.originLabel,
            destLabel: a.destLabel,
            departDate: a.departDate,
            returnDate: a.returnDate || undefined,
            passengers: a.passengers,
            travelClass: a.travelClass,
            currency: a.currency,
            basePrice: a.basePrice,
            desiredPrice: a.desiredPrice,
            notifyOnRise: a.notifyOnRise,
          },
          useSearchStore.getState().authToken,
        );
        /**
         * Die neue Server-Kennung übernehmen.
         *
         * Ohne das zeigte die Liste zwar den Alarm, das Löschen liefe aber auf
         * die ALTE Kennung — und die gibt es nicht mehr. Der Alarm wäre
         * sichtbar und unlöschbar.
         */
        if (res.id !== a.serverId) {
          useSearchStore.getState().updatePriceAlertServerId(a.id, res.id);
        }
      } catch {
        // Einzelne Strecke fehlgeschlagen — die anderen trotzdem versuchen.
      }
    }
  } catch {
    // Siehe oben: bewusst still.
  }
}

/**
 * NACHHOLEN, was die App verpasst hat, während sie nicht lief.
 *
 * DAS WAR DIE LÜCKE, und sie ist keine Kleinigkeit: Eine Meldung, die bei toter
 * App eintrifft, zeigt Android NATIV an — ohne JavaScript zu starten. Tippt der
 * Nutzer sie an, holt der Tipp sie ab (`PriceAlertRouter`). Öffnet er die App
 * stattdessen normal, erfährt sie auf KEINEM anderen Weg davon:
 * `getLastNotificationResponseAsync` liefert nur etwas nach einem echten Tipp.
 *
 * Der Alarm blieb dann für immer unter „Gespeichert" stehen, unter der Glocke
 * kam nie etwas an, und von außen sah es aus, als funktioniere die ganze
 * Funktion nicht. Genau so wurde es gemeldet: „über die Meldung geht es, normal
 * rein nicht".
 *
 * Der Server ist hier die einzige Quelle — er hat gemeldet, also weiß er es. Er
 * merkt sich dazu den Preis VON DAMALS (`notifiedPrice`), nicht den zuletzt
 * gesehenen: Eine Zahl von heute unter eine Meldung von gestern zu schreiben
 * wäre eine Erfindung, und wir schätzen keine Preise.
 *
 * Läuft still und VOR `syncPriceAlerts`. Die Reihenfolge ist zwingend: Der
 * Abgleich legt die lokalen Alarme erneut an, und der Server setzt dabei
 * `lastNotifiedAt` zurück — also genau das Kennzeichen, an dem diese Funktion
 * einen ausgelösten Alarm erkennt. Andersherum gerufen wäre der Beweis fort,
 * bevor jemand ihn liest.
 */
export async function catchUpFiredAlerts(): Promise<void> {
  try {
    const token = knownPushToken() ?? (await restorePushToken());
    if (!token) return;

    const server = await listPriceAlerts(token, useSearchStore.getState().authToken);
    const fired = server.filter((a) => a.lastNotifiedAt && Number(a.notifiedPrice) > 0);
    if (fired.length === 0) return;

    for (const a of fired) {
      const price = Number(a.notifiedPrice);
      const base = Number(a.basePrice);
      /**
       * Der Prozentsatz wird hier NACHGERECHNET, nicht mitgeschickt.
       *
       * Es ist dieselbe Formel wie auf dem Server (`buildAlertPush`), und sie
       * steht auf denselben zwei Zahlen — Grundpreis und gemeldeter Preis —,
       * die beide aus der Datenbank kommen. Ein zusätzliches Feld dafür wäre
       * eine dritte Stelle, an der dieselbe Rechnung steht.
       */
      const pct = base > 0 ? Math.round(((base - price) / base) * 100) : 0;
      useSearchStore.getState().addAlertHit({
        mode: a.mode,
        origin: a.origin,
        destination: a.destination,
        originLabel: a.originLabel,
        destLabel: a.destLabel,
        departDate: a.departDate,
        ...(a.returnDate ? { returnDate: a.returnDate } : {}),
        passengers: a.passengers,
        travelClass: a.travelClass,
        currency: a.currency,
        price,
        pct,
        /**
         * Der Zeitpunkt der MELDUNG, nicht der des Abholens.
         *
         * Unter der Glocke steht ein Datum. „Heute" zu schreiben, weil die App
         * heute nachgesehen hat, wäre falsch — die Meldung kam vorgestern.
         */
        receivedAt: a.lastNotifiedAt ?? new Date().toISOString(),
      });

      /**
       * Und auf dem Server wegräumen — sonst holt der nächste Start ihn erneut.
       *
       * Ohne das entstünde bei jedem Öffnen derselbe Eintrag neu. Der Speicher
       * ersetzt zwar gleiche Strecken, aber der rote Punkt an der Glocke zählte
       * jedes Mal hoch, und der Alarm wäre nicht loszuwerden.
       */
      try {
        await deletePriceAlert(a.id, token);
      } catch {
        // Bleibt er stehen, versucht es der nächste Start erneut. Der Eintrag
        // unter der Glocke ist dann einen Lauf lang doppelt gezählt — das ist
        // die harmlosere Hälfte gegenüber einem Alarm, der unauffindbar wird.
      }
    }
  } catch {
    // Ohne Netz passiert nichts; beim nächsten Start wird es erneut versucht.
  }
}
