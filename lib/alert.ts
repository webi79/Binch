import { create } from "zustand";

export type AlertButtonStyle = "default" | "cancel" | "destructive";

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
  show: (title: string, body?: string, buttons?: AlertButton[]) => void;
  dismiss: () => void;
}

export const useAlertStore = create<AlertState>((set) => ({
  visible: false,
  show: (title, body, buttons) => set({ visible: true, title, body, buttons }),
  dismiss: () => set({ visible: false, title: undefined, body: undefined, buttons: undefined }),
}));

/** Drop-in replacement for `Alert.alert(title, body, buttons)`. */
export function showAlert(title: string, body?: string, buttons?: AlertButton[]) {
  useAlertStore.getState().show(title, body, buttons);
}
