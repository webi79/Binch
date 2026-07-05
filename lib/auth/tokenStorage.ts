/**
 * Session-Token-Speicher: expo-secure-store (Android Keystore / iOS Keychain)
 * statt AsyncStorage. AsyncStorage ist eine unverschlüsselte Datei, die je
 * nach Gerät in Backups landet — Bearer-Tokens gehören da nicht rein.
 *
 * Guarded require: Der aktuell installierte Dev-Client hat das Native-Modul
 * evtl. noch nicht (braucht einen neuen EAS-Build). Bis dahin — und auf Web,
 * wo SecureStore nicht existiert — fällt der Speicher auf AsyncStorage
 * zurück (Status quo, keine Regression). Sobald SecureStore verfügbar ist,
 * migriert `loadAuthToken` einen evtl. vorhandenen Fallback-Wert automatisch.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

type SecureStoreModule = typeof import("expo-secure-store");

let SecureStore: SecureStoreModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  SecureStore = require("expo-secure-store") as SecureStoreModule;
} catch {
  SecureStore = null;
}

const KEY = "binch.authToken";

async function secureAvailable(): Promise<boolean> {
  if (!SecureStore) return false;
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

export async function saveAuthToken(token: string | null): Promise<void> {
  try {
    if (await secureAvailable()) {
      if (token) {
        await SecureStore!.setItemAsync(KEY, token);
      } else {
        await SecureStore!.deleteItemAsync(KEY);
      }
      // Evtl. Fallback-Kopie aus der Vor-SecureStore-Ära entsorgen.
      void AsyncStorage.removeItem(KEY).catch(() => {});
      return;
    }
  } catch {
    /* SecureStore-Fehler → Fallback unten */
  }
  try {
    if (token) await AsyncStorage.setItem(KEY, token);
    else await AsyncStorage.removeItem(KEY);
  } catch {
    /* best effort */
  }
}

export async function loadAuthToken(): Promise<string | null> {
  try {
    if (await secureAvailable()) {
      const secure = await SecureStore!.getItemAsync(KEY);
      if (secure) return secure;
      // Migration: Wert liegt noch im AsyncStorage-Fallback → umziehen.
      const fallback = await AsyncStorage.getItem(KEY);
      if (fallback) {
        await SecureStore!.setItemAsync(KEY, fallback);
        void AsyncStorage.removeItem(KEY).catch(() => {});
        return fallback;
      }
      return null;
    }
  } catch {
    /* Fallback unten */
  }
  try {
    return (await AsyncStorage.getItem(KEY)) ?? null;
  } catch {
    return null;
  }
}
