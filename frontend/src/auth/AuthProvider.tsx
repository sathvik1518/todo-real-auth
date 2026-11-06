import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { bootstrap, getSession, signIn, signOut, signUp, subscribe, type SessionState } from "../session";

interface AuthValue extends SessionState {
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}
const AuthContext = createContext<AuthValue | null>(null);

/** Wrap the app once. On first load it tries the refresh cookie, so a reload does not sign you out. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(subscribe, getSession);
  useEffect(() => {
    void bootstrap();
  }, []);
  const value = useMemo<AuthValue>(() => ({ ...session, signIn, signUp, signOut }), [session]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>.");
  return value;
}
