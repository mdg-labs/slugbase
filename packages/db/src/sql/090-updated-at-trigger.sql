-- The updated_at trigger of doc 05 section 1. public.set_updated_at() is the one
-- trigger function every editable table attaches, as a BEFORE UPDATE row trigger
-- named <table>_set_updated_at, in a file of this directory. It runs with the
-- privileges of the session that writes the row, so it needs none of its own, and
-- it overwrites whatever the statement wrote to updated_at.
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER accounts_set_updated_at
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
