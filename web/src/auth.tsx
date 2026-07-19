import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { getPublicConfig, setAuthTokenGetter } from "./api";
import type { PublicConfig } from "./types";

/**
 * Auth bootstrap. Fetches /api/public/config (no auth) to learn the server's
 * auth mode, then:
 *  - supabase: initializes the Supabase client, tracks the session, and points
 *    api.ts at the live access token (supabase-js refreshes it automatically).
 *  - token:    legacy DASHBOARD_TOKEN mode — api.ts default getter already
 *    reads localStorage; App shows the TokenGate on 401.
 *  - open:     zero-config local dev — no gate at all.
 */

export interface AuthState {
  /** undefined while /api/public/config is loading. */
  config?: PublicConfig;
  configError?: string;
  supabase?: SupabaseClient;
  session: Session | null;
  /** True once the initial session restore has settled (supabase mode only). */
  sessionReady: boolean;
  signOut: () => Promise<void>;
  retryConfig: () => void;
}

const AuthCtx = createContext<AuthState>({
  session: null,
  sessionReady: false,
  signOut: async () => {},
  retryConfig: () => {},
});

export const useAuth = (): AuthState => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<PublicConfig | undefined>(undefined);
  const [configError, setConfigError] = useState<string | undefined>(undefined);
  const [configTick, setConfigTick] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionReady, setSessionReady] = useState(false);

  useEffect(() => {
    let alive = true;
    setConfigError(undefined);
    getPublicConfig()
      .then((c) => alive && setConfig(c))
      .catch((e) => alive && setConfigError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [configTick]);

  const supabase = useMemo(() => {
    if (config?.authMode !== "supabase" || !config.supabaseUrl || !config.supabaseAnonKey) return undefined;
    return createClient(config.supabaseUrl, config.supabaseAnonKey);
  }, [config]);

  useEffect(() => {
    if (!supabase) {
      // token/open modes are "ready" as soon as config arrives.
      if (config) setSessionReady(true);
      return;
    }
    // api.ts asks for the freshest access token per request; getSession() is
    // cached in-memory by supabase-js and refreshes ahead of expiry.
    setAuthTokenGetter(async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? "";
    });
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase, config]);

  const value: AuthState = {
    config,
    configError,
    supabase,
    session,
    sessionReady,
    signOut: async () => {
      await supabase?.auth.signOut();
    },
    retryConfig: () => setConfigTick((t) => t + 1),
  };

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
