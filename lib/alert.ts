import { create } from "zustand";

export type AlertButtonStyle = "default" | "cancel" | "destructive";

/**
 * Das Bild über dem Titel — nur zu setzen, wenn die Meldung eines braucht, das
 * der Host nicht selbst herleiten kann.
 *
 * Ohne Angabe entscheidet er: rotes Ausrufezeichen, sobald ein Knopf löscht,
 * sonst das Info-Zeichen im Akzentton.
 */
export type AlertArt = "bo-sad";

export interface AlertButton {
  text: string;
  style?: AlertButtonStyle;
  onPress?: () => void;
}

interface AlertState {
  visible: boolean;
  title?: string;
  body?: string;
  buttons?: AlertButton[];
  art?: AlertArt;
  show: (title: string, body?: string, buttons?: AlertButton[], art?: AlertArt) => void;
  dismiss: () => void;
}

export const useAlertStore = create<AlertState>((set) => ({
  visible: false,
  show: (title, body, buttons, art) => set({ visible: true, title, body, buttons, art }),
  dismiss: () =>
    set({ visible: false, title: undefined, body: undefined, buttons: undefined, art: undefined }),
}));

/** Drop-in replacement for `Alert.alert(title, body, buttons)`. */
export function showAlert(
  title: string,
  body?: string,
  buttons?: AlertButton[],
  art?: AlertArt,
) {
  useAlertStore.getState().show(title, body, buttons, art);
}
