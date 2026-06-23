import { defineBlogCollection } from "@mdg-labs/blog";

const blog = defineBlogCollection({
  contentBase: "./src/content/blog",
  locales: ["en", "de"],
  defaultAuthor: "SlugBase",
});

export const collections = {
  blog,
};
