-- A migration that drops the slug column of the bookmarks, with the search document and the indexes that were built on it.
ALTER TABLE public.bookmarks DROP COLUMN slug CASCADE;
