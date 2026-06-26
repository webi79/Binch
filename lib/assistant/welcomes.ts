/**
 * Welcome-Varianten für Bo. Pro Sprache mehrere Optionen — pickWelcome()
 * wählt zufällig eine aus, damit der User nicht immer mit dem gleichen Satz
 * begrüßt wird.
 *
 * Format: Markdown-`**fett**` wird im Chat in der Akzent-Farbe gerendert,
 * also bewusst auf 1-2 Schlüsselwörter setzen (meist „Bo" oder den Modus).
 */
import type { Locale } from "@/lib/i18n/dict";

const WELCOMES: Record<Locale, string[]> = {
  de: [
    "Hallo! Ich bin **Bo**, dein Reise-Geist. Wohin soll die Reise heute gehen?",
    "Hey, schön dass du da bist! Wo darf ich dich denn hinbringen?",
    "Hi! Bereit für die nächste Reise? Sag einfach, wo's hingehen soll.",
    "Servus! Ich bin **Bo** und plan dir gleich was Feines — wohin denn?",
    "Schön dich zu sehen! Was hast du dir denn für deine nächste Reise überlegt?",
    "Hallo! Steht heute eine neue Reise an? Erzähl mal, wo du hin willst.",
    "Tach! **Bo** am Apparat — wo soll's für dich hingehen?",
    "Hi! Ich helfe dir gern bei der Reise-Planung — wohin möchtest du denn?",
  ],
  en: [
    "Hi! I'm **Bo**, your travel ghost. Where would you like to go today?",
    "Hey, nice to see you! Where can I take you?",
    "Hi! Ready for your next trip? Just tell me where you'd like to go.",
    "Welcome back! Where are we heading this time?",
    "Hi there — what's the plan for your next trip?",
    "Hello! I'm **Bo** and I'll plan something nice for you — where to?",
    "Hey! Let's plan a trip together — where would you like to go?",
    "Hi! Tell me where you'd like to travel and I'll take it from there.",
  ],
  fr: [
    "Salut ! Je suis **Bo**, ton fantôme de voyage. Où veux-tu aller aujourd'hui ?",
    "Coucou, content de te voir ! Où puis-je t'emmener ?",
    "Salut ! Prêt pour un nouveau voyage ? Dis-moi simplement où tu veux aller.",
    "Bonjour ! Quel est le plan pour ton prochain voyage ?",
    "Hé ! **Bo** ici — dis-moi où tu veux partir.",
    "Salut ! Tu as une nouvelle destination en tête ? Raconte-moi.",
  ],
  es: [
    "¡Hola! Soy **Bo**, tu fantasma de viajes. ¿A dónde quieres ir hoy?",
    "¡Hey, qué bueno verte! ¿A dónde te puedo llevar?",
    "¡Hola! ¿Listo para un nuevo viaje? Solo dime a dónde quieres ir.",
    "¡Hola! ¿Qué tienes planeado para tu próximo viaje?",
    "¡Hola! Aquí **Bo** — cuéntame, ¿cuál es tu destino?",
    "¡Buenas! ¿Tienes un nuevo viaje en mente? Cuéntame.",
  ],
};

/**
 * Liefert eine zufällige Begrüßung für die aktuelle Sprache. Wenn die Sprache
 * keine Variante hat (sollte nie passieren, aber Safety), fällt auf Deutsch
 * zurück.
 */
export function pickWelcome(locale: Locale): string {
  const variants = WELCOMES[locale] ?? WELCOMES.de;
  return variants[Math.floor(Math.random() * variants.length)];
}
