const ACCENT_STORAGE_KEY = 'slugbase_accent'

/**
 * Applies accent color CSS variables on `<html>` and persists to localStorage.
 * Mirrors `claude_design_v3/SlugBase.html` `applyAccent` (hex + 2-char alpha suffixes).
 */
export function applyAccent(hex: string): void {
  const trimmed = hex.trim()
  if (!/^#[0-9A-Fa-f]{6}$/.test(trimmed)) {
    return
  }
  const root = document.documentElement
  root.style.setProperty('--accent', trimmed)
  root.style.setProperty('--accent-hi', trimmed)
  root.style.setProperty('--accent-bg', trimmed + '1f')
  root.style.setProperty('--accent-bg-hi', trimmed + '3a')
  root.style.setProperty('--accent-ring', trimmed + '59')
  localStorage.setItem(ACCENT_STORAGE_KEY, trimmed)
}
