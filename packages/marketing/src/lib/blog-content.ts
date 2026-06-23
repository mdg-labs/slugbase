import type { CollectionEntry } from "astro:content";
import { getCollection } from "astro:content";

/** Load blog collection entries (typed at Astro content boundary). */
export async function getBlogCollectionEntries(): Promise<
  CollectionEntry<"blog">[]
> {
  return (await getCollection("blog")) as CollectionEntry<"blog">[];
}
