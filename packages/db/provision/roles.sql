-- Database roles of doc 05 section 3.1. Run by a superuser, once per database
-- (the compose files run it on first start; the test harness and the CE
-- compose file reuse it):
--
--   psql -v ON_ERROR_STOP=1 -v app_password=... -v migrator_password=... -f roles.sql
--
-- The passwords of the two login roles come from the psql variables
-- app_password and migrator_password, or, when a variable is not set, from the
-- environment variables PROVISION_APP_PASSWORD and PROVISION_MIGRATOR_PASSWORD
-- (this is how the Postgres image's init directory runs the file). They are
-- applied when a role is created; running the script again never changes a
-- password, so rotate one with ALTER ROLE.
--
-- Idempotent: every run converges the four roles, their memberships and the
-- CREATE privileges of the current database to the same state, and a second
-- run changes nothing. All of it happens in one transaction, so a failure
-- leaves nothing half applied. Per-table grants are not part of this script.

\set ON_ERROR_STOP on

SELECT current_setting('is_superuser') = 'on' AS is_superuser \gset
\if :is_superuser
\else
  DO $$ BEGIN
    RAISE EXCEPTION 'roles.sql must be run by a superuser: it creates roles and changes ownership and privileges';
  END $$;
\endif

\if :{?app_password}
\else
  \getenv app_password PROVISION_APP_PASSWORD
\endif
\if :{?migrator_password}
\else
  \getenv migrator_password PROVISION_MIGRATOR_PASSWORD
\endif
\if :{?app_password}
\else
  DO $$ BEGIN
    RAISE EXCEPTION 'psql variable app_password (or PROVISION_APP_PASSWORD) is not set';
  END $$;
\endif
\if :{?migrator_password}
\else
  DO $$ BEGIN
    RAISE EXCEPTION 'psql variable migrator_password (or PROVISION_MIGRATOR_PASSWORD) is not set';
  END $$;
\endif
SELECT :'app_password' <> '' AND :'migrator_password' <> '' AS passwords_set \gset
\if :passwords_set
\else
  DO $$ BEGIN
    RAISE EXCEPTION 'the passwords of slugbase_app and slugbase_migrator must not be empty';
  END $$;
\endif

BEGIN;

-- Roles are cluster-wide and advisory locks are per database, so concurrent
-- runs against one cluster (several clones sharing a development Postgres)
-- serialize on the role catalog. The lock is released at COMMIT.
LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;

-- slugbase_owner: owns the schema objects, never logs in.
SELECT 'CREATE ROLE slugbase_owner NOLOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'slugbase_owner')
\gexec
ALTER ROLE slugbase_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- slugbase_migrator: logs in for `migrate`, which does its DDL as slugbase_owner.
SELECT format('CREATE ROLE slugbase_migrator LOGIN PASSWORD %L', :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'slugbase_migrator')
\gexec
ALTER ROLE slugbase_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- slugbase_app: what the server and the worker connect as. Row-level security
-- applies to it; it owns nothing and cannot change the schema.
SELECT format('CREATE ROLE slugbase_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'slugbase_app')
\gexec
ALTER ROLE slugbase_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- slugbase_system: owns the SECURITY DEFINER functions of doc 05 section 3.3
-- and nothing else; nobody logs in as it.
SELECT 'CREATE ROLE slugbase_system NOLOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'slugbase_system')
\gexec
ALTER ROLE slugbase_system NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;

-- Memberships: the migrator is a member of slugbase_owner, without inheriting
-- its privileges: it acts as the owner only through an explicit SET ROLE. The
-- owner is a member of slugbase_system, inheriting it, so that a migration can
-- hand a SECURITY DEFINER function to slugbase_system (ALTER FUNCTION ... OWNER
-- TO) and replace it later; slugbase_system holds no privilege the owner lacks,
-- and BYPASSRLS is an attribute of a role that membership does not pass on.
-- No other role is a member of anything, and these two memberships are the only ones.
DO $$
DECLARE
  m record;
BEGIN
  FOR m IN
    SELECT pg_get_userbyid(am.roleid) AS parent,
           pg_get_userbyid(am.member) AS member,
           pg_get_userbyid(am.grantor) AS grantor
    FROM pg_auth_members am
    WHERE pg_get_userbyid(am.member) IN ('slugbase_app', 'slugbase_system')
       OR (pg_get_userbyid(am.member) = 'slugbase_owner'
           AND (pg_get_userbyid(am.roleid) <> 'slugbase_system'
                OR NOT am.inherit_option OR NOT am.set_option OR am.admin_option))
       OR (pg_get_userbyid(am.member) = 'slugbase_migrator'
           AND (pg_get_userbyid(am.roleid) <> 'slugbase_owner'
                OR am.inherit_option OR NOT am.set_option OR am.admin_option))
  LOOP
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', m.parent, m.member, m.grantor);
  END LOOP;
END $$;
GRANT slugbase_owner TO slugbase_migrator WITH INHERIT FALSE, SET TRUE;
GRANT slugbase_system TO slugbase_owner WITH INHERIT TRUE, SET TRUE;

-- The current database: the login roles may connect, only the owner may create
-- schemas.
SELECT format('REVOKE CREATE ON DATABASE %I FROM PUBLIC, slugbase_app, slugbase_migrator, slugbase_system', current_database())
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO slugbase_app, slugbase_migrator', current_database())
\gexec
SELECT format('GRANT CREATE ON DATABASE %I TO slugbase_owner', current_database())
\gexec

-- slugbase_owner owns the public schema; nobody but its owner can create
-- objects in any schema.
ALTER SCHEMA public OWNER TO slugbase_owner;
DO $$
DECLARE
  s name;
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace
    WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
  LOOP
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC, slugbase_app, slugbase_migrator, slugbase_system', s);
  END LOOP;
END $$;

COMMIT;
