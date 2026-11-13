-- A migration that stops forcing row-level security on the bookmarks.
ALTER TABLE public.bookmarks NO FORCE ROW LEVEL SECURITY;
