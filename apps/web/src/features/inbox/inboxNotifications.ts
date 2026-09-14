import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Telling an agent a customer wrote, when they are not looking (ADR-040 §5).
 *
 * Two independent switches, both remembered per browser:
 *
 * - **Sound:** a short chime, on by default. It needs no permission.
 * - **Desktop notifications:** off until the agent turns them on, because the
 *   browser asks for permission and a prompt nobody requested is how
 *   permissions get denied forever.
 *
 * Nothing here is sent to the server; it is this browser's preference.
 */

const STORAGE_KEY = "serviqo_inbox_notifications";

interface Preferences {
  sound: boolean;
  desktop: boolean;
}

function readPreferences(): Preferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { sound: true, desktop: false };
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return { sound: parsed.sound !== false, desktop: parsed.desktop === true };
  } catch {
    return { sound: true, desktop: false };
  }
}

function writePreferences(preferences: Preferences) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage blocked: the switch still works for this page.
  }
}

type Permission = "default" | "granted" | "denied" | "unsupported";

function currentPermission(): Permission {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") return "unsupported";
  return window.Notification.permission;
}

/** Two short tones, generated rather than shipped as a file. */
function playChime() {
  try {
    const AudioContextClass =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass === undefined) return;
    const context = new AudioContextClass();
    const now = context.currentTime;
    [880, 1175].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      oscillator.type = "sine";
      gain.gain.setValueAtTime(0.0001, now + index * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.18, now + index * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.12 + 0.18);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + index * 0.12);
      oscillator.stop(now + index * 0.12 + 0.2);
    });
    setTimeout(() => void context.close().catch(() => undefined), 600);
  } catch {
    // Audio blocked until the user interacts with the page; nothing to do.
  }
}

export interface InboxNotifications {
  soundEnabled: boolean;
  desktopEnabled: boolean;
  desktopPermission: Permission;
  toggleSound: () => void;
  toggleDesktop: () => Promise<void>;
  /** A customer wrote. Plays and shows according to the preferences. */
  notify: (title: string, body: string) => void;
}

export function useInboxNotifications(): InboxNotifications {
  const [preferences, setPreferences] = useState<Preferences>(readPreferences);
  const [desktopPermission, setDesktopPermission] = useState<Permission>(currentPermission);
  const preferencesRef = useRef(preferences);

  useEffect(() => {
    preferencesRef.current = preferences;
    writePreferences(preferences);
  }, [preferences]);

  const toggleSound = useCallback(() => {
    setPreferences((current) => ({ ...current, sound: !current.sound }));
  }, []);

  const toggleDesktop = useCallback(async () => {
    if (preferencesRef.current.desktop) {
      setPreferences((current) => ({ ...current, desktop: false }));
      return;
    }
    if (currentPermission() === "unsupported") return;

    const permission = currentPermission() === "default" ? await window.Notification.requestPermission() : currentPermission();
    setDesktopPermission(permission as Permission);
    if (permission === "granted") setPreferences((current) => ({ ...current, desktop: true }));
  }, []);

  const notify = useCallback((title: string, body: string) => {
    const { sound, desktop } = preferencesRef.current;
    if (sound) playChime();
    if (desktop && currentPermission() === "granted" && document.visibilityState === "hidden") {
      try {
        const notification = new window.Notification(title, { body, tag: "serviqo-inbox" });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch {
        // Some browsers only allow notifications from a service worker.
      }
    }
  }, []);

  return {
    soundEnabled: preferences.sound,
    desktopEnabled: preferences.desktop && desktopPermission === "granted",
    desktopPermission,
    toggleSound,
    toggleDesktop,
    notify,
  };
}
