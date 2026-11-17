CREATE SCHEMA composed;
--> statement-breakpoint
GRANT USAGE ON SCHEMA composed TO slugbase_app;
--> statement-breakpoint
CREATE FUNCTION composed.sys_composed_ok() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $body$SELECT 1$body$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA composed TO slugbase_system;
--> statement-breakpoint
ALTER FUNCTION composed.sys_composed_ok() OWNER TO slugbase_system;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA composed FROM slugbase_system;
--> statement-breakpoint
REVOKE ALL ON FUNCTION composed.sys_composed_ok() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION composed.sys_composed_ok() TO slugbase_app;
--> statement-breakpoint
CREATE FUNCTION composed.sys_composed_faulty() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $body$SELECT 1$body$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION composed.sys_composed_faulty() TO PUBLIC;
