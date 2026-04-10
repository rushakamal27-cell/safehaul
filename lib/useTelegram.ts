"use client";
import { useEffect, useState } from "react";

export interface TelegramUser {
  id: string;
  firstName: string;
  username?: string;
}

const DEV_FALLBACK: TelegramUser = {
  id: "dev-local",
  firstName: "Dev Driver",
};

export function useTelegram(): TelegramUser | null {
  const [user, setUser] = useState<TelegramUser | null>(null);

  useEffect(() => {
    try {
      const tg = (window as any).Telegram?.WebApp;
      const tgUser = tg?.initDataUnsafe?.user;

      if (tgUser?.id) {
        setUser({
          id:        String(tgUser.id),
          firstName: tgUser.first_name ?? "",
          username:  tgUser.username,
        });
      } else {
        // Telegram SDK unavailable — use dev fallback so the app works locally
        setUser(DEV_FALLBACK);
      }
    } catch {
      setUser(DEV_FALLBACK);
    }
  }, []);

  return user;
}
