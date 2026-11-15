/**
 * Light/dark theme. The applied theme is the `dark` class on <html>; the preference
 * ("system", "light" or "dark") lives in localStorage. "system" follows the OS setting, also
 * when it changes. THEME_SCRIPT runs before first paint (inlined in the root layout) so the
 * page never flashes the wrong theme.
 */
export type Theme = "light" | "dark";
export type ThemePref = Theme | "system";

const STORAGE_KEY = "sx600.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${STORAGE_KEY}");if(t!=="light"&&t!=="dark")t=matchMedia("${DARK_QUERY}").matches?"dark":"light";document.documentElement.classList.toggle("dark",t==="dark")}catch(e){}})()`;

export function getTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function getThemePref(): ThemePref {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    if (t === "light" || t === "dark") return t;
  } catch {
    // storage blocked
  }
  return "system";
}

const systemTheme = (): Theme => (matchMedia(DARK_QUERY).matches ? "dark" : "light");

function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  listeners.forEach((l) => l());
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // not remembered; still applied for this visit
  }
  apply(pref === "system" ? systemTheme() : pref);
}

/** The sidebar toggle: picks the opposite of what is showing now. */
export function setTheme(theme: Theme) {
  setThemePref(theme);
}

export function subscribeTheme(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

// Follow the OS while the preference is "system".
if (typeof window !== "undefined") {
  matchMedia(DARK_QUERY).addEventListener("change", () => {
    if (getThemePref() === "system") apply(systemTheme());
  });
}
