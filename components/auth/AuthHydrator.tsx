import { useEffect } from "react";
import { useSearchStore } from "@/stores/searchStore";
import { authMe } from "@/lib/api/client";

/**
 * Mounted once at app root. If a persisted bearer token exists, validate it
 * with /api/auth/me on cold start. If the token is invalid/expired, clear
 * local auth state so the user is treated as logged out.
 */
export function AuthHydrator() {
  const token = useSearchStore((s) => s.authToken);
  const setAuthUser = useSearchStore((s) => s.setAuthUser);
  const clearAuth = useSearchStore((s) => s.clearAuth);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const user = await authMe(token);
        if (!cancelled) setAuthUser(user);
      } catch {
        if (!cancelled) clearAuth();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, setAuthUser, clearAuth]);

  return null;
}
