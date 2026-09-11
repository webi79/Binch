import { createPriceAlert, deletePriceAlert } from "@/lib/api/client";
import { knownPushToken, restorePushToken } from "@/lib/notifications/push";
import { useSearchStore } from "@/stores/searchStore";
import type { PriceAlert } from "@/types/saved";

/**
 * Einen Alarm an- oder abschalten — SERVER ZUERST, dann die Anzeige.
 *
 * Die Reihenfolge ist die ganze Sache. Andersherum verschwände der Alarm aus
 * der Liste und läge weiter auf dem Server: Er meldete sich alle zwölf Stunden,
 * und niemand könnte ihn noch finden. Das ist der schlechteste aller Ausgänge —
 * der Nutzer glaubt, er sei ihn los.
 *
 * Der Server ist die Wahrheit: Dort wird geprüft und zugestellt. Die Liste in
 * der App ist die Anzeige davon, nicht umgekehrt.
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
 */
async function token(): Promise<string | null> {
  return knownPushToken() ?? (await restorePushToken());
}

export async function setAlertActiveOnServer(alert: PriceAlert, on: boolean): Promise<ToggleResult> {
  const tok = await token();
  if (!tok) return { ok: false, reason: "nopush" };

  if (!on) {
    /**
     * Ohne Server-Kennung gibt es nichts zu löschen.
     *
     * Ältere Einträge haben keine, und ein abgeschalteter Alarm hat sie
     * ebenfalls nicht mehr. Beides ist kein Fehler: Auf dem Server steht dann
     * schon nichts, was zustellen könnte.
     */
    if (!alert.serverId) return { ok: true };
    try {
      await deletePriceAlert(alert.serverId, tok);
      return { ok: true };
    } catch {
      return { ok: false, reason: "server" };
    }
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
    );
    return { ok: true, serverId: res.id };
  } catch {
    return { ok: false, reason: "server" };
  }
}
