import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";

const AuthContext = createContext<{ session: Session | null; ready: boolean; epoch: number }>({ session: null, ready: true, epoch: 0 });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ session: Session | null; ready: boolean; epoch: number }>({ session: null, ready: false, epoch: 0 });
  useEffect(() => {
    const client = getSupabase();
    if (!client) { setState({ session: null, ready: true, epoch: 0 }); return; }
    let active = true, events = 0;
    const update = (session: Session | null) => {
      if (active) setState(previous => ({ session, ready: true,
        epoch: previous.epoch + (previous.session?.user.id !== session?.user.id ? 1 : 0) }));
    };
    // 콜백 안에서 SDK를 다시 호출하면 세션 잠금을 기다릴 수 있으므로 상태만 바꾼다.
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => { events += 1; update(session); });
    const initial = events;
    void client.auth.getSession().then(({ data, error }) => {
      if (events === initial) update(error ? null : data.session);
    }).catch(() => { if (events === initial) update(null); });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
