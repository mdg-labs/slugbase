/** Whether the keyboard is an Apple one, whose shortcut key is Command and whose Alt key is Option. */
export function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent);
}
