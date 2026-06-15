export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export type NavigateToExternalUrlOptions = {
  /** Open in a new tab (default true). When false, navigates the current window. */
  newTab?: boolean;
  /** Called when the URL scheme is not http or https. */
  onInvalid?: () => void;
};

/**
 * Opens an external bookmark URL only when the scheme is http or https.
 * Returns true when navigation was attempted, false when blocked.
 */
export function navigateToExternalUrl(
  url: string,
  options: NavigateToExternalUrlOptions = {},
): boolean {
  if (!isSafeExternalUrl(url)) {
    options.onInvalid?.();
    return false;
  }

  const newTab = options.newTab ?? true;
  if (newTab) {
    window.open(url, "_blank", "noopener,noreferrer");
  } else {
    window.location.assign(url);
  }

  return true;
}
