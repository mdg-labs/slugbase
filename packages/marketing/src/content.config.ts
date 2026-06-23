import { defineBlogCollection } from "@mdg-labs/blog";

const blog = defineBlogCollection({
  contentBase: "./src/content/blog",
  locales: ["en", "de"],
});

export const collections = {
  blog,
};
