import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Prüfung der ID-Tokens von Apple und Google.
 *
 * DAS IST DIE SICHERHEITSKRITISCHE STELLE DER GANZEN FUNKTION.
 *
 * Der Client schickt uns ein Token und behauptet damit, wer er ist. Dieses
 * Token stammt aber aus einer Umgebung, die dem Nutzer gehört — jeder kann eine
 * beliebige Zeichenkette an unseren Endpunkt schicken. Es gibt genau einen
 * Grund, ihm zu glauben: die Signatur des Anbieters. Wer die nicht prüft, hat
 * keine Anmeldung gebaut, sondern ein Formular, in das man fremde Konto-IDs
 * eintragen kann.
 *
 * Geprüft wird deshalb alles davon, und ein Fehlschlag in einem Punkt lässt die
 * ganze Prüfung scheitern:
 *
 *  1. **Signatur** gegen den öffentlichen Schlüsselsatz (JWKS) des Anbieters,
 *     live abgerufen und von `jose` zwischengespeichert. Damit sind gefälschte
 *     und veränderte Token ausgeschlossen.
 *  2. **`iss`** — kommt das Token wirklich von Google bzw. Apple.
 *  3. **`aud`** — ist es für UNSERE App ausgestellt. Ohne diese Prüfung könnte
 *     jemand ein gültiges Google-Token einer FREMDEN App vorlegen und wäre bei
 *     uns angemeldet. Das ist der Fehler, der in echten Anwendungen am
 *     häufigsten übersehen wird.
 *  4. **`exp`/`iat`** — Gültigkeitsdauer, mit knapper Toleranz gegen
 *     Uhren-Abweichungen. Erledigt `jose` selbst.
 *
 * Verknüpft wird anschließend NUR über `sub` (die Kennung des Anbieters), nie
 * über die E-Mail. Begründung steht bei `OAuthIdentity.email`.
 */

/** Anbieter, die wir unterstützen. */
export type OAuthProvider = "google" | "apple";

export interface OAuthIdentity {
  provider: OAuthProvider;
  /** `sub` aus dem Token — die einzige stabile Kennung. */
  subject: string;
  /**
   * Die E-Mail aus dem Token, wenn der Anbieter eine mitschickt.
   *
   * NIEMALS als Verknüpfungsschlüssel benutzen. Zwei Gründe:
   *  • Apples „E-Mail verbergen" liefert pro App eine eigene Relay-Adresse; sie
   *    identifiziert die Person nicht.
   *  • Eine E-Mail, die der Anbieter nicht als bestätigt meldet, sagt gar
   *    nichts aus — wer sie als Schlüssel nimmt, öffnet die Übernahme fremder
   *    Konten durch bloßes Eintragen derselben Adresse beim Anbieter.
   */
  email: string | null;
  /** Nur wenn der Anbieter die E-Mail ausdrücklich als bestätigt meldet. */
  emailVerified: boolean;
  /** Vorname/Nachname, sofern der Anbieter sie mitgibt (Google tut es). */
  firstName: string | null;
  lastName: string | null;
}

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";

/**
 * Die Schlüsselsätze werden EINMAL angelegt, nicht pro Anfrage.
 *
 * `createRemoteJWKSet` bringt einen eigenen Zwischenspeicher samt Ratenbremse
 * mit und holt nur nach, wenn ein unbekannter Schlüssel auftaucht (also bei
 * einer Schlüsselrotation des Anbieters). Pro Anfrage neu angelegt wäre das ein
 * Netzabruf pro Anmeldung — und ein wunderbarer Hebel, uns über unseren eigenen
 * Endpunkt gegen Google laufen zu lassen.
 */
const googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
const appleJwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));

/**
 * Erlaubte Empfänger je Anbieter, aus der Umgebung.
 *
 * Google vergibt PRO PLATTFORM eine eigene Client-ID (Android, iOS, Web), und
 * das Token trägt die der Plattform, auf der es entstanden ist. Es müssen also
 * alle akzeptiert werden, die zu unserer App gehören — aber eben nur die.
 * Kommagetrennt in einer Variablen, damit hier nichts hartkodiert steht.
 */
function audiencesFor(provider: OAuthProvider): string[] {
  const raw =
    provider === "google"
      ? process.env.GOOGLE_CLIENT_IDS ?? ""
      : process.env.APPLE_CLIENT_IDS ?? "";
  return raw
    .split(",")
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);
}

/** Wird geworfen, wenn ein Token die Prüfung nicht besteht. */
export class OAuthVerifyError extends Error {
  constructor(
    message: string,
    readonly reason: "unconfigured" | "invalid",
  ) {
    super(message);
    this.name = "OAuthVerifyError";
  }
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Prüft ein ID-Token und gibt die enthaltene Identität zurück.
 *
 * Wirft `OAuthVerifyError`, wenn irgendetwas nicht stimmt — der Aufrufer darf
 * daraus KEINE Details an den Client geben (siehe Route).
 */
export async function verifyOAuthIdToken(
  provider: OAuthProvider,
  idToken: string,
): Promise<OAuthIdentity> {
  const audience = audiencesFor(provider);
  if (audience.length === 0) {
    // Ohne konfigurierte Empfänger würde `jose` die Prüfung überspringen — und
    // damit läge exakt die Lücke offen, gegen die dieser Punkt geschrieben ist.
    // Lieber gar keine Anmeldung als eine ungeprüfte.
    throw new OAuthVerifyError(
      `Keine Client-IDs für ${provider} konfiguriert (${provider === "google" ? "GOOGLE_CLIENT_IDS" : "APPLE_CLIENT_IDS"})`,
      "unconfigured",
    );
  }

  let payload: JWTPayload;
  try {
    const res = await jwtVerify(
      idToken,
      provider === "google" ? googleJwks : appleJwks,
      {
        issuer: provider === "google" ? GOOGLE_ISSUERS : APPLE_ISSUER,
        audience,
        // Tiefenstaffelung. `jose` lehnt symmetrische Verfahren und `alg: none`
        // gegen einen Schlüsselsatz ohnehin strukturell ab — beides ist
        // gegengeprüft. Die ausdrückliche Liste kostet nichts und macht die
        // Annahme sichtbar, statt sie einer Bibliotheks-Eigenschaft zu
        // überlassen, die sich mit einer Version ändern könnte.
        algorithms: ["RS256", "ES256"],
        // Toleranz gegen Uhren-Abweichungen zwischen Gerät, Anbieter und uns.
        // Knapp gehalten: Sie verlängert die Lebensdauer eines abgelaufenen
        // Tokens um genau diesen Betrag.
        clockTolerance: 30,
        /**
         * KEIN `maxTokenAge`.
         *
         * Hier standen 10 Minuten, und genau daran ist die Anmeldung mit
         * `"iat" claim timestamp check failed (too far in the past)` gescheitert.
         * Der Grund liegt im nativen SDK: Es gibt Token aus seinem eigenen
         * Zwischenspeicher heraus, statt für jeden Aufruf ein frisches zu holen.
         * Deren `iat` liegt dann beliebig weit zurück — bis zu einer Stunde,
         * denn so lange sind Google-Token gültig.
         *
         * Die Gültigkeit begrenzt weiterhin `exp`, und das ist hier auch die
         * richtige Grenze: Der zusätzliche Riegel war gegen WIEDEREINLÖSUNG
         * eines abgefangenen Tokens gedacht — und abfangen kann es seit dem
         * Wechsel auf das native SDK niemand mehr. Es gibt keinen
         * Browser-Rücklauf und kein URI-Schema, das eine fremde App für sich
         * beanspruchen könnte; das Token verlässt den Prozess nie.
         */
      },
    );
    payload = res.payload;
  } catch (err) {
    throw new OAuthVerifyError(
      `Token-Prüfung fehlgeschlagen: ${err instanceof Error ? err.message : "unbekannt"}`,
      "invalid",
    );
  }

  const subject = nonEmpty(payload.sub);
  if (!subject) {
    throw new OAuthVerifyError("Token ohne `sub`", "invalid");
  }

  // `email_verified` kommt bei Google als boolean, bei Apple gelegentlich als
  // Zeichenkette "true" — beide Formen akzeptieren, alles andere als
  // unbestätigt behandeln.
  const rawVerified = (payload as Record<string, unknown>).email_verified;
  const emailVerified = rawVerified === true || rawVerified === "true";

  const given = nonEmpty((payload as Record<string, unknown>).given_name);
  const family = nonEmpty((payload as Record<string, unknown>).family_name);

  return {
    provider,
    subject,
    email: nonEmpty((payload as Record<string, unknown>).email)?.toLowerCase() ?? null,
    emailVerified,
    firstName: given,
    lastName: family,
  };
}
