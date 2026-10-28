import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { clearAdminSession, readAdminSession, SESSION_EVENT, type AdminSession } from "./session";

const AuthContext = createContext<{ session: AdminSession | null; ready: boolean; epoch: number }>({ session: null, ready: true, epoch: 0 });
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ session: AdminSession | null; ready: boolean; epoch: number }>({ session: null, ready: false, epoch: 0 });
  useEffect(() => {
    const update = () => {
      let session: AdminSession | null;
      try { session = readAdminSession(); } catch { session = null; }
      setState(previous => ({ session, ready: true, epoch: previous.epoch + (previous.session?.session_id !== session?.session_id ? 1 : 0) }));
    };
    window.addEventListener(SESSION_EVENT, update);
    update();
    return () => window.removeEventListener(SESSION_EVENT, update);
  }, []);
  useEffect(() => {
    if (!state.session) return;
    const id = state.session.session_id;
    const timer = setTimeout(() => clearAdminSession(id), Math.max(0, state.session.expires_at * 1000 - Date.now()));
    return () => clearTimeout(timer);
  }, [state.session?.expires_at, state.session?.session_id]);
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
