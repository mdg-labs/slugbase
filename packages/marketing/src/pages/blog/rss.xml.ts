import type { APIRoute } from "astro";
import {
  buildRssFeed,
  filterPublished,
  sortPostsByDate,
} from "@mdg-labs/blog";
import { getBlogCollectionEntries } from "../../lib/blog-content.js";
import { getBlogSiteConfig } from "../../lib/blog-site-config.js";

export const prerender = true;

export const GET: APIRoute = async () => {
  const rawPosts = await getBlogCollectionEntries();
  const posts = sortPostsByDate(filterPublished(rawPosts));

  const xml = buildRssFeed({
    site: getBlogSiteConfig("en"),
    posts,
  });

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
};
