import { apiFetch } from "../../lib/client-api-fetch.js";
import {
  chooseGoSlug,
  resolveGoSlugJson,
  type GoCandidate,
  type GoDisambiguationData,
} from "../../components/command-palette/go-mode-api.js";

export type { GoCandidate, GoDisambiguationData };

export async function deleteSlugPreference(id: string): Promise<void> {
  const res = await apiFetch(`/api/go/preferences/${encodeURIComponent(id)}`, {
    method: "DELETE",
    csrf: true,
  });
  if (!res.ok) throw new Error("delete_failed");
}

export async function fetchDisambiguationCandidates(
  slug: string,
): Promise<GoCandidate[]> {
  const result = await resolveGoSlugJson(slug);
  if (result.kind !== "disambiguation") {
    throw new Error("not_ambiguous");
  }
  return result.candidates;
}

export async function updateSlugPreference(
  slug: string,
  bookmarkId: string,
): Promise<void> {
  await chooseGoSlug(slug, bookmarkId, true);
}
