import { useEffect, useState } from "react";
import type { DashboardWindowRole } from "./window-role";

export type DashboardMode = "light" | "dark";
export type DashboardAccent = "slate" | "blue" | "red" | "green" | "amber";
export type DashboardBackground = "slate" | "ocean" | "sand" | "forest" | "wine";
type LegacyDashboardTheme = "light" | "dark" | "blue" | "red" | "green";

export interface DashboardAppearance {
  mode: DashboardMode;
  accent: DashboardAccent;
  background: DashboardBackground;
}

export const modeOptions: Array<{ id: DashboardMode; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export const accentOptions: Array<{ id: DashboardAccent; label: string }> = [
  { id: "slate", label: "Slate" },
  { id: "blue", label: "Blue" },
  { id: "red", label: "Red" },
  { id: "green", label: "Green" },
  { id: "amber", label: "Amber" },
];

export const backgroundOptions: Array<{ id: DashboardBackground; label: string }> = [
  { id: "slate", label: "Slate" },
  { id: "ocean", label: "Ocean" },
  { id: "sand", label: "Sand" },
  { id: "forest", label: "Forest" },
  { id: "wine", label: "Wine" },
];

const modeStorageKey = "ica.dashboard.mode";
const accentStorageKey = "ica.dashboard.accent";
const backgroundStorageKey = "ica.dashboard.background";
const legacyThemeStorageKey = "ica.dashboard.theme";

function isDashboardMode(value: string | null): value is DashboardMode {
  return value === "light" || value === "dark";
}

function isDashboardAccent(value: string | null): value is DashboardAccent {
  return value === "slate" || value === "blue" || value === "red" || value === "green" || value === "amber";
}

function isDashboardBackground(value: string | null): value is DashboardBackground {
  return value === "slate" || value === "ocean" || value === "sand" || value === "forest" || value === "wine";
}

function isLegacyTheme(value: string | null): value is LegacyDashboardTheme {
  return value === "light" || value === "dark" || value === "blue" || value === "red" || value === "green";
}

function mapLegacyTheme(theme: LegacyDashboardTheme): DashboardAppearance {
  switch (theme) {
    case "light":
      return { mode: "light", accent: "slate", background: "slate" };
    case "dark":
      return { mode: "dark", accent: "slate", background: "slate" };
    case "blue":
      return { mode: "dark", accent: "blue", background: "ocean" };
    case "red":
      return { mode: "dark", accent: "red", background: "wine" };
    case "green":
      return { mode: "dark", accent: "green", background: "forest" };
  }
}

export function readStoredAppearance(): DashboardAppearance {
  if (typeof window === "undefined") {
    return { mode: "light", accent: "slate", background: "slate" };
  }

  try {
    const storedMode = window.localStorage.getItem(modeStorageKey);
    const storedAccent = window.localStorage.getItem(accentStorageKey);
    const storedBackground = window.localStorage.getItem(backgroundStorageKey);
    if (isDashboardMode(storedMode) && isDashboardAccent(storedAccent) && isDashboardBackground(storedBackground)) {
      return { mode: storedMode, accent: storedAccent, background: storedBackground };
    }

    const legacyTheme = window.localStorage.getItem(legacyThemeStorageKey);
    if (isLegacyTheme(legacyTheme)) {
      return mapLegacyTheme(legacyTheme);
    }
  } catch {
    // Ignore storage access errors.
  }

  return { mode: "light", accent: "slate", background: "slate" };
}

function writeStoredAppearance(appearance: DashboardAppearance): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(modeStorageKey, appearance.mode);
    window.localStorage.setItem(accentStorageKey, appearance.accent);
    window.localStorage.setItem(backgroundStorageKey, appearance.background);
  } catch {
    // Ignore storage access errors.
  }
}

export function applyAppearanceToDocument(appearance: DashboardAppearance): void {
  if (typeof document === "undefined") {
    return;
  }

  document.body.dataset.mode = appearance.mode;
  document.body.dataset.accent = appearance.accent;
  document.body.dataset.background = appearance.background;
  document.documentElement.dataset.mode = appearance.mode;
  document.documentElement.dataset.accent = appearance.accent;
  document.documentElement.dataset.background = appearance.background;
}

export function useDashboardAppearance(windowRole: DashboardWindowRole): DashboardAppearance & {
  canEditAppearance: boolean;
  setMode(mode: DashboardMode): void;
  setAccent(accent: DashboardAccent): void;
  setBackground(background: DashboardBackground): void;
} {
  const [appearance, setAppearance] = useState<DashboardAppearance>(() => readStoredAppearance());

  useEffect(() => {
    applyAppearanceToDocument(appearance);
  }, [appearance]);

  useEffect(() => {
    if (windowRole !== "settings") {
      return;
    }
    writeStoredAppearance(appearance);
  }, [appearance, windowRole]);

  useEffect(() => {
    if (windowRole !== "main" || typeof window === "undefined") {
      return;
    }

    const onStorage = (event: StorageEvent): void => {
      if (event.key && event.key !== modeStorageKey && event.key !== accentStorageKey && event.key !== backgroundStorageKey && event.key !== legacyThemeStorageKey) {
        return;
      }
      setAppearance(readStoredAppearance());
    };

    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, [windowRole]);

  return {
    ...appearance,
    canEditAppearance: windowRole === "settings",
    setMode(mode) {
      setAppearance((current) => (current.mode === mode ? current : { ...current, mode }));
    },
    setAccent(accent) {
      setAppearance((current) => (current.accent === accent ? current : { ...current, accent }));
    },
    setBackground(background) {
      setAppearance((current) => (current.background === background ? current : { ...current, background }));
    },
  };
}
