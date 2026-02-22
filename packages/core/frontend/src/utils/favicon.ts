/**
 * Get favicon URL for a given website URL
 * Tries multiple methods to get the favicon
 */
export function getFaviconUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const origin = urlObj.origin;
    
    // Try common favicon locations
    return `${origin}/favicon.ico`;
  } catch {
    // If URL parsing fails, return empty string
    return '';
  }
}

/**
 * Fetch favicon with fallback handling
 * Returns a favicon URL or empty string if it can't be determined
 */
export async function fetchFavicon(url: string): Promise<string> {
  try {
    const urlObj = new URL(url);
    const origin = urlObj.origin;
    
    // Try direct favicon.ico first (most reliable)
    const directFavicon = `${origin}/favicon.ico`;
    
    // Return the direct favicon URL - let the browser handle loading
    // If it fails, the component will show the fallback icon
    return directFavicon;
  } catch {
    return '';
  }
}
