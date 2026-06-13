/** Server-side API origin for React Router loaders/actions (Workers + Node). */
export function getServerApiBaseUrl(): string {
  const fromProcess = process.env["API_BASE_URL"];
  if (typeof fromProcess === "string" && fromProcess.length > 0) {
    return fromProcess.replace(/\/$/, "");
  }

  const fromVite = import.meta.env.VITE_API_URL as string | undefined;
  if (typeof fromVite === "string" && fromVite.length > 0) {
    return fromVite.replace(/\/$/, "");
  }

  return "";
}
