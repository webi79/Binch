import { Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import Constants from "expo-constants";

import { authOAuth } from "@/lib/api/client";
import type { AuthResponse } from "@/lib/api/client";

/**
 * Anmeldung über Apple und Google.
 *
 * WAS HIER PASSIERT — und was ausdrücklich NICHT:
 *
 * Diese Datei holt beim Anbieter ein **ID-Token** und reicht es an unseren
 * Server weiter. Sie entscheidet nichts. Ob jemand angemeldet ist, entscheidet
 * allein der Server, nachdem er die Signatur des Anbieters geprüft hat
 * (`server/src/services/oauthVerify.ts`). Alles, was der Client behauptet, ist
 * unverbindlich — er läuft auf einem Gerät, das dem Nutzer gehört.
 *
 * Deshalb steht hier auch kein Geheimnis. Client-IDs sind öffentlich; ein
 * Client-Secret gehört niemals in eine mobile App, weil jede installierte App
 * es preisgibt. Der Ablauf ist entsprechend gewählt:
 *
 *  • **Google** über das native SDK der Play-Dienste. Kein Browser, keine
 *    Rücklauf-Adresse — das Token kommt direkt vom System. Warum nicht über den
 *    Browser, steht bei `signInWithGoogle`.
 *  • **Apple** über das native Modul. Es liefert das Token vom System, ohne
 *    Browser.
 */

/**
 * Die Client-IDs kommen aus der App-Konfiguration, nicht aus dem Code.
 *
 * Google vergibt pro Plattform eine eigene — und das ID-Token trägt die der
 * Plattform, auf der es entstanden ist. Der Server muss deshalb genau diese
 * IDs als gültige Empfänger kennen (`GOOGLE_CLIENT_IDS` dort). Passen die
 * beiden Seiten nicht zusammen, lehnt er jede Anmeldung ab — das ist so
 * gewollt, siehe die Empfänger-Prüfung dort.
 */
function extra(key: string): string | undefined {
  const v = (Constants.expoConfig?.extra as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function googleClientId(): string | undefined {
  // EINE ID für beide Plattformen: die des Web-Clients. Siehe `ensureConfigured`
  // — das native SDK stellt das Token immer auf ihn aus, unabhängig davon, über
  // welchen Plattform-Client die App autorisiert wurde.
  return extra("googleWebClientId");
}

/** Ist die Anmeldung über Google eingerichtet? Steuert die Sichtbarkeit. */
export function isGoogleAvailable(): boolean {
  return googleClientId() != null;
}

/**
 * Apple gibt es nur auf iOS.
 *
 * Auf Android ginge es ausschließlich über Apples Web-Fluss, und der verlangt
 * ein signiertes Client-Secret — also einen privaten Schlüssel, der nur auf
 * einem Server liegen darf. Ein halb funktionierender Knopf ist schlechter als
 * keiner: `isAvailableAsync` fragt zusätzlich das Gerät (alte iOS-Versionen).
 */
export async function isAppleAvailable(): Promise<boolean> {
  if (Platform.OS !== "ios") return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

/** Der Nutzer hat den Anbieter-Dialog abgebrochen — kein Fehler. */
export class SignInCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "SignInCancelled";
  }
}

/**
 * Einmalige Einrichtung des nativen Google-Anmeldedienstes.
 *
 * `webClientId` ist NICHT die Client-ID der Android-App, und das ist der Punkt,
 * an dem man sich leicht vertut: Das SDK meldet sich zwar über den
 * Android-Client an (der autorisiert die App über Paketname und Fingerabdruck),
 * stellt das ID-Token aber auf den WEB-Client aus. Dessen ID steht deshalb im
 * `aud` des Tokens — und genau die muss der Server als gültigen Empfänger
 * kennen.
 *
 * Ein Client-Secret braucht es nicht. Der Web-Client hat eins, aber es gehört
 * auf einen Server, der Codes eintauscht — hier tauscht niemand etwas ein, das
 * Token kommt fertig von den Play-Diensten.
 */
let configured = false;
function ensureConfigured(webClientId: string): void {
  if (configured) return;
  GoogleSignin.configure({
    webClientId,
    // Fordert ausdrücklich ein ID-Token an. Ohne das liefert das SDK nur ein
    // Zugriffs-Token, und damit kann unser Server nichts anfangen — er prüft
    // eine Signatur, keine Zugriffsrechte.
    offlineAccess: false,
    scopes: ["email", "profile"],
  });
  configured = true;
}

export async function signInWithGoogle(): Promise<AuthResponse> {
  const webClientId = googleClientId();
  if (!webClientId) throw new Error("Google ist nicht eingerichtet");
  ensureConfigured(webClientId);

  /**
   * Kein Browser, keine Rücklauf-Adresse.
   *
   * Vorher lief das über den Browser mit einem eigenen URI-Schema. Google hat
   * genau das für neue Android-Clients abgeschaltet und antwortet mit
   * „Custom URI scheme is not enabled for your Android client" — nachgemessen,
   * mit beiden dokumentierten Schreibweisen. Der Weg ist also nicht falsch
   * konfiguriert, sondern schlicht nicht mehr vorgesehen.
   *
   * Die Play-Dienste liefern das Token stattdessen direkt an die App. Damit
   * entfällt die ganze Angriffsfläche der Rücklauf-Adresse: Es gibt kein
   * Schema, das eine fremde App für sich beanspruchen könnte, und das Token
   * verlässt nie den Prozess.
   */
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

  const res = await GoogleSignin.signIn();
  if (res.type === "cancelled") throw new SignInCancelled();

  const idToken = res.data.idToken;
  if (!idToken) throw new Error("Google hat kein Token geliefert");

  try {
    return await authOAuth({ provider: "google", idToken });
  } catch (err) {
    /**
     * Bei einer Absage des Servers die Google-Sitzung wieder lösen.
     *
     * Das SDK merkt sich das gewählte Konto. Ohne diese Zeile liefert der
     * nächste `signIn()` es sofort und ohne Auswahl zurück — der Server lehnt
     * dasselbe Konto wieder ab, und der Nutzer sitzt fest: Die Meldung erscheint
     * augenblicklich erneut, die Kontoauswahl geht gar nicht mehr auf.
     *
     * Genau dieser Fall ist bei uns nicht selten, sondern vorgesehen: Gibt es
     * für die Adresse schon ein Passwort-Konto, verweigern wir das Verknüpfen
     * (siehe Server). Wer dann ein ANDERES Google-Konto nehmen will, muss die
     * Auswahl wieder bekommen.
     *
     * `signOut` betrifft nur die Verbindung zwischen Binch und dem Konto auf
     * diesem Gerät — es meldet niemanden aus Google ab.
     */
    try {
      await GoogleSignin.signOut();
    } catch {
      /* Wenn schon das Abmelden scheitert, hilft es dem Nutzer nicht, das
         statt des eigentlichen Fehlers zu sehen. */
    }
    throw err;
  }
}

export async function signInWithApple(): Promise<AuthResponse> {
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (err) {
    // Apple meldet den Abbruch als Fehler mit diesem Code.
    if ((err as { code?: string })?.code === "ERR_REQUEST_CANCELED") {
      throw new SignInCancelled();
    }
    throw err;
  }

  if (!credential.identityToken) throw new Error("Apple hat kein Token geliefert");

  /**
   * Den Namen NUR beim ersten Mal.
   *
   * Apple liefert `fullName` ausschließlich bei der allerersten Anmeldung einer
   * App — danach ist das Feld leer, auch wenn man die App löscht und neu
   * installiert. Der Server nimmt ihn deshalb entgegen und speichert ihn beim
   * Anlegen des Kontos. Er ist reine Anzeige und beeinflusst keine
   * Zugriffsentscheidung — deshalb darf er aus dem Client kommen.
   */
  return authOAuth({
    provider: "apple",
    idToken: credential.identityToken,
    firstName: credential.fullName?.givenName ?? undefined,
    lastName: credential.fullName?.familyName ?? undefined,
  });
}

/**
 * Beim Abmelden aus Binch auch die Verbindung zum Google-Konto lösen.
 *
 * Ohne das merkt sich das SDK das zuletzt gewählte Konto über die Abmeldung
 * hinaus: Wer sich abmeldet und mit einem ANDEREN Google-Konto neu anmelden
 * will, bekäme keine Auswahl mehr, sondern stillschweigend wieder das alte.
 *
 * Das meldet niemanden aus Google ab — es löst nur die Verknüpfung zwischen
 * dieser App und dem Konto auf diesem Gerät. Fehler werden bewusst geschluckt:
 * Das Abmelden aus Binch darf nicht daran scheitern, dass Google gerade nicht
 * erreichbar ist.
 */
export async function forgetSocialSession(): Promise<void> {
  try {
    await GoogleSignin.signOut();
  } catch {
    /* siehe oben */
  }
}
