import {
  ALERT_ACTION_TIMEOUT_MS,
  createPriceAlert,
  deletePriceAlert,
  updatePriceAlertActive,
} from "@/lib/api/client";
import { knownPushToken, pushTokenForCleanup, restorePushToken } from "@/lib/notifications/push";
import { useSearchStore } from "@/stores/searchStore";
import type { PriceAlert } from "@/types/saved";

/**
 * Einen Alarm pausieren, fortsetzen oder löschen — SERVER ZUERST, dann die Liste.
 *
 * Die Reihenfolge ist die ganze Sache. Andersherum verschwände der Alarm aus
 * der Liste und läge weiter auf dem Server: Er meldete sich alle zwölf Stunden,
 * und niemand könnte ihn noch finden. Das ist der schlechteste aller Ausgänge —
 * der Nutzer glaubt, er sei ihn los.
 *
 * Der Server ist die Wahrheit: Dort wird geprüft und zugestellt. Die Liste in
 * der App ist die Anzeige davon, nicht umgekehrt.
 *
 * PAUSE IST NICHT LÖSCHEN. Der Schalter rief hier lange `deletePriceAlert` —
 * „aus" war damit eine Kündigung, und „an" legte einen neuen Alarm an. Gemeint
 * ist etwas anderes, und der Unterschied war auch messbar: neue Kennung,
 * zurückgesetzte Entprellung, verlorener `lastSeenPrice`. Heute legt der
 * Schalter nur einen Merker um (`PATCH`), gelöscht wird ausschließlich über das
 * Herz — mit Rückfrage davor.
 */
export type ToggleResult =
  | { ok: true; serverId?: string }
  /** Kein Zustellweg zu bekommen — ohne den ergäbe ein Alarm keinen Sinn. */
  | { ok: false; reason: "nopush" }
  /** Der Server hat abgelehnt oder war nicht erreichbar. */
  | { ok: false; reason: "server" };

/**
 * Die Kennung notfalls erst BESORGEN.
 *
 * `knownPushToken` liest einen Zwischenspeicher, und der ist nach jedem
 * App-Start leer. `restorePushToken` fragt nichts nach — es holt die Kennung
 * nur, wenn die Erlaubnis ohnehin erteilt ist. Wer einen Alarm hat, hat sie
 * erteilt; ohne sie wäre er nie zustande gekommen.
 *
 * HIER WARTET NIEMAND AUF DAS NETZ, und das wurde eigens nachgesehen, als die
 * Meldung über eine zu spät kommende Fehlermeldung kam: `PriceAlertRouter` füllt
 * den Zwischenspeicher beim Start, der Regelfall ist also ein Speicherzugriff.
 * Und selbst der Umweg bleibt trocken — die Erlaubnis und der Kanal sind
 * geräteseitig, Firebase gibt eine einmal vergebene Kennung aus seinem eigenen
 * Speicher zurück, und die Anmeldung beim Server läuft dort ausdrücklich OHNE
 * `await` (siehe `push.ts`). Die Wartezeit steckte allein in der Zeitgrenze der
 * Aufrufe unten (`ALERT_ACTION_TIMEOUT_MS` in `lib/api/client.ts`).
 */
async function token(): Promise<string | null> {
  return knownPushToken() ?? (await restorePushToken());
}

export async function setAlertActiveOnServer(alert: PriceAlert, on: boolean): Promise<ToggleResult> {
  const tok = await token();
  if (!tok) return { ok: false, reason: "nopush" };

  /**
   * Der Regelfall: Die Zeile liegt auf dem Server, also wird dort nur ihr
   * Merker umgelegt. Kennung, Schwelle und zuletzt gesehener Preis bleiben
   * stehen — genau das unterscheidet eine Pause von einer Kündigung.
   */
  if (alert.serverId) {
    try {
      const res = await updatePriceAlertActive(alert.serverId, tok, on);
      if (res === "ok") return { ok: true };
      /**
       * `"gone"` — die Zeile gibt es dort nicht mehr. Das passiert, wenn die
       * Push-Kennung gewechselt hat (Neuinstallation, Wiederherstellung, von
       * Firebase als tot gemeldet): Die Alarme hängen per Kaskade daran.
       *
       * Beim AUSSCHALTEN ist damit nichts mehr zu tun — es meldet ja nichts
       * mehr. Beim Einschalten fällt der Weg unten durch und legt ihn neu an.
       */
      if (!on) return { ok: true };
    } catch {
      return { ok: false, reason: "server" };
    }
  } else if (!on) {
    /**
     * Ohne Server-Kennung gibt es nichts zu pausieren.
     *
     * Ältere Einträge haben keine. Kein Fehler: Auf dem Server steht dann
     * nichts, was zustellen könnte.
     */
    return { ok: true };
  }

  try {
    const res = await createPriceAlert(
      {
        pushToken: tok,
        mode: alert.mode,
        origin: alert.origin,
        destination: alert.destination,
        originLabel: alert.originLabel,
        destLabel: alert.destLabel,
        departDate: alert.departDate,
        returnDate: alert.returnDate || undefined,
        passengers: alert.passengers,
        travelClass: alert.travelClass,
        currency: alert.currency,
        basePrice: alert.basePrice,
        desiredPrice: alert.desiredPrice,
        notifyOnRise: alert.notifyOnRise,
      },
      useSearchStore.getState().authToken,
      // Hier steht ein Mensch am Schalter — siehe `ALERT_ACTION_TIMEOUT_MS`.
      ALERT_ACTION_TIMEOUT_MS,
    );
    return { ok: true, serverId: res.id };
  } catch {
    return { ok: false, reason: "server" };
  }
}

/**
 * Einen Alarm WIRKLICH löschen — erst auf dem Server, dann in der Liste.
 *
 * WARUM DAS EINE EIGENE FUNKTION IST: Der Löschweg der Karte rief bisher das
 * Ausschalten und ließ es ganz aus, wenn der Alarm schon aus war („dann steht
 * dort ja nichts mehr"). Die Abkürzung stimmte genau so lange, wie Ausschalten
 * Löschen bedeutete. Seit es eine Pause ist, liegt die Zeile weiter dort — und
 * ohne diesen Aufruf verschwände die Karte aus der App, während der Alarm für
 * immer in der Datenbank bliebe. Unsichtbar UND unerreichbar, denn die einzige
 * Kennung dafür ging mit der Karte.
 *
 * Deshalb hier ohne jede Bedingung auf `active`: Gelöscht wird, was es gibt.
 */
export async function deleteAlertOnServer(alert: PriceAlert): Promise<ToggleResult> {
  /**
   * Zum Löschen reicht die Kennung OHNE Erlaubnis — siehe `pushTokenForCleanup`.
   *
   * Sonst entstünde die schlimmste Sorte Sackgasse: Wer die Meldungen
   * abschaltet, könnte seine Alarme danach nicht mehr loswerden. Die Kennung
   * dient hier als Ausweis gegenüber dem eigenen Server, nicht als Zustellweg.
   */
  const tok = (await pushTokenForCleanup()) ?? (await token());
  if (!tok) {
    /**
     * Gar keine Kennung zu bekommen — dann lokal entfernen, und das ist
     * ausnahmsweise richtig.
     *
     * Ohne Kennung kann dieses Gerät die Zeile auf dem Server weder erreichen
     * noch je wieder etwas von ihr empfangen. Sie stehen zu lassen hieße, dem
     * Nutzer eine unlöschbare Karte zu hinterlassen — und zwar für eine Zeile,
     * die ohnehin nichts mehr ausrichten kann.
     *
     * Dass dabei kein ewiger Rest bleibt, ist nicht gehofft, sondern gebaut:
     * Meldet Firebase die Kennung als nicht mehr registriert, löscht der Server
     * sie samt ihrer Alarme (`sendPush` in `priceAlerts.ts`, die Alarme hängen
     * per Kaskade daran).
     */
    return { ok: true };
  }
  /**
   * Ohne Server-Kennung ist nichts zu löschen — und das ist hier belastbar,
   * nicht bloß angenommen: Ein Alarm entsteht nur, NACHDEM der Server ihn
   * bestätigt hat, und seine Kennung wird mitgespeichert (`ResultsView`). Der
   * Abgleich beim Start trägt sie nach, falls sie wechselt (`syncAlerts`).
   */
  if (!alert.serverId) return { ok: true };
  try {
    /**
     * Ein 404 „Unknown alert" gilt in `deletePriceAlert` als Erfolg — er ist
     * der Beweis, dass dort nichts mehr liegt. Ein 404 „Unknown device" wirft;
     * dann wurde nichts gelöscht und die Karte muss stehen bleiben.
     */
    await deletePriceAlert(alert.serverId, tok);
    return { ok: true };
  } catch {
    return { ok: false, reason: "server" };
  }
}
