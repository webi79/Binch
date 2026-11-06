import { ALERT_ACTION_TIMEOUT_MS, createPriceAlert } from "@/lib/api/client";
import { ensurePushToken } from "@/lib/notifications/push";
import { showAlert } from "@/lib/alert";
import { haptic } from "@/lib/haptics";
import { useSearchStore } from "@/stores/searchStore";
import type { TravelMode } from "@/types/search";

/**
 * Einen Preis-Alarm für eine SUCHE anlegen — aus der Ergebnisliste oder aus dem
 * Kasten über dem Stadt-Blatt auf der Karte.
 *
 * Stand bis eben als Rückruf in `ResultsView`. Seit die Glocke auch über der
 * Karte sitzt, gibt es zwei Aufrufer; zwei Kopien dieses Ablaufs liefen beim
 * nächsten Feinschliff (Zustellweg, Rundung, Rückdatum) garantiert auseinander.
 *
 * Die Strecke wird MIT Beschriftung gespeichert, nicht nur mit Codes: Ein
 * Alarm wird später irgendwo aufgelistet, und „FRA → ZRH" sagt dort weniger
 * als „Frankfurt (Main) Hbf". Die Codes bleiben trotzdem dabei — sie sind
 * das, womit eine Prüfung später wirklich suchen kann.
 */
export interface SearchAlertRequest {
  mode: TravelMode;
  origin: string;
  destination: string;
  originLabel: string;
  destLabel: string;
  departDate: string;
  /** "" = einfache Fahrt. */
  returnDate: string;
  passengers: number;
  travelClass: string;
  /** Tarifprofil der Suche (lib/travel/fareProfile.ts) — leer = ohne Karte. */
  fareProfile: string;
  currency: string;
  /** Der günstigste Preis der Suche, UNGERUNDET — gerundet wird hier. */
  cheapestPrice: number;
  desiredPrice: number;
  notifyOnRise: boolean;
}

export function createSearchAlert(
  req: SearchAlertRequest,
  t: (key: string) => string,
): void {
  /**
   * Erst der Zustellweg, dann der Alarm.
   *
   * Die Berechtigung wird GENAU HIER erfragt und nicht beim App-Start: An
   * dieser Stelle ist der Zweck offensichtlich, und unter Android ist ein
   * „Nie erlauben" endgültig. Ohne Kennung wird gar kein Alarm angelegt —
   * ein gespeicherter Alarm, den niemand zustellen kann, wäre ein
   * Versprechen ohne Deckung.
   */
  void (async () => {
    /**
     * Wer einen Alarm anlegt, will ihn bekommen.
     *
     * Stehen „Benachrichtigungen" oder „Preisalarme" in den Einstellungen auf
     * AUS, bliebe der neue Alarm sonst stumm — und niemand verstünde, warum.
     * Die Anfrage nach einem Alarm ist der deutlichste Wunsch, den es dazu
     * gibt. Den Server erreicht der neue Stand über die Anmeldung gleich
     * darunter bzw. das Abonnement in `PriceAlertRouter`.
     */
    const st = useSearchStore.getState();
    if (!st.notificationsEnabled) st.setNotificationsEnabled(true);
    if (!st.priceAlertsEnabled) st.setPriceAlertsEnabled(true);
    const push = await ensurePushToken();
    if (!push.ok) {
      /**
       * Die beiden Fälle AUSEINANDERHALTEN.
       *
       * „Erlaubnis verweigert" schickt den Nutzer sinnvoll in die
       * Systemeinstellungen. „Kein Zustellweg" tut das nicht — dort findet
       * er nichts, weil das Problem am Build hängt und nicht an ihm. Eine
       * Meldung, die auf die falsche Ursache zeigt, ist schlimmer als gar
       * keine; genau das war hier der Fall.
       */
      // „Nicht jetzt" im Blatt vor der Abfrage: still bleiben — der Nutzer hat gerade selbst entschieden.
      if (push.reason === "later") return;
      if (push.reason === "denied") {
        showAlert(t("alert.nopush.title"), t("alert.nopush.body"));
      } else {
        showAlert(
          t("alert.nochannel.title"),
          `${t("alert.nochannel.body")}\n\n${push.detail}`,
        );
      }
      return;
    }
    const pushToken = push.token;
    /**
     * GERUNDET — dieselbe Zahl, die das Blatt angezeigt hat.
     *
     * Das Blatt rechnet mit `Math.round(currentPrice)`, hier ging der
     * Rohwert hinaus. Bei 9,99 € stand auf dem Bildschirm ein
     * Grundpreis von 10, während der Server 9,99 bekam — und wies die
     * Anfrage zurück, weil der Wunschpreis nicht darunter lag. Beim
     * Nutzer kam nur „Alarm konnte nicht angelegt werden" an, ohne
     * Grund. Maßgeblich ist die Zahl, die er gesehen hat.
     */
    const basePrice = Math.round(req.cheapestPrice);
    try {
      const created = await createPriceAlert(
        {
          pushToken,
          mode: req.mode,
          origin: req.origin,
          destination: req.destination,
          originLabel: req.originLabel,
          destLabel: req.destLabel,
          departDate: req.departDate,
          /**
           * Die Rückreise gehört MIT — sonst ist der Alarm mehrdeutig.
           *
           * Eine Suche mit Rückreise liefert eine andere Trefferliste als
           * dieselbe Strecke ohne, also einen anderen günstigsten Preis.
           * Fehlte sie, verglich der Server die Schwelle einer Hin- und
           * Rückreise später mit dem Preis einer einfachen Fahrt — und
           * meldete beim nächsten Mal sofort einen Preissturz, den es nie
           * gab.
           */
          returnDate: req.returnDate || undefined,
          // Reisende, Klasse und Tarif gehören zum Preis — siehe `PriceAlert`.
          passengers: req.passengers,
          travelClass: req.travelClass,
          fareProfile: req.fareProfile,
          currency: req.currency,
          basePrice,
          desiredPrice: req.desiredPrice,
          notifyOnRise: req.notifyOnRise,
        },
        // Angemeldet? Dann verknüpft der Server den Alarm zusätzlich mit dem
        // Konto, und er überlebt einen Gerätewechsel. Ohne Anmeldung geht es
        // trotzdem.
        useSearchStore.getState().authToken,
        // Das Blatt steht offen und wartet — also die kurze Zeitgrenze, nicht
        // die zwanzig Sekunden des Hintergrund-Abgleichs.
        ALERT_ACTION_TIMEOUT_MS,
      );
      /**
       * Lokal spiegeln, NACHDEM der Server bestätigt hat.
       *
       * Die Reihenfolge ist der Punkt: Der Server ist die Wahrheit, weil
       * dort geprüft wird. Der lokale Eintrag ist nur die Anzeige — ihn
       * vorher zu setzen hieße, einen Alarm anzuzeigen, den es nicht gibt.
       */
      useSearchStore.getState().addPriceAlertNoted(
        {
          // Die Kennung vom Server MIT merken — ohne sie ließe sich der
          // Alarm später nur aus der Anzeige entfernen, nicht vom Server.
          serverId: created.id,
          mode: req.mode,
          origin: req.origin,
          destination: req.destination,
          originLabel: req.originLabel,
          destLabel: req.destLabel,
          departDate: req.departDate,
          returnDate: req.returnDate,
          passengers: req.passengers,
          travelClass: req.travelClass,
          fareProfile: req.fareProfile,
          currency: req.currency,
          // Dieselbe gerundete Zahl wie beim Server — die Anzeige darf
          // nicht behaupten, der Alarm hänge an einem anderen Preis.
          basePrice,
          desiredPrice: req.desiredPrice,
          notifyOnRise: req.notifyOnRise,
        },
        /**
         * Der Hinweis sagt, WAS entstanden ist, die Unterzeile WO es liegt.
         *
         * Ohne ihn passierte nach dem Anlegen sichtbar nichts: Das Blatt
         * schloss sich, und der Alarm lag in einem Reiter, den man gerade
         * nicht ansieht. Man musste annehmen, es sei nichts passiert. Der
         * rote Punkt am Reiter kommt aus demselben Aufruf.
         */
        t("alert.saved.title"),
        `${req.originLabel} – ${req.destLabel}`,
      );
      haptic("important");
    } catch {
      showAlert(t("alert.failed.title"), t("alert.failed.body"));
    }
  })();
}
