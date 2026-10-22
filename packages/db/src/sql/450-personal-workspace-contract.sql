-- The contract half of the unlimited personal-workspace function (doc 05 sections 3.3 and 5.2, Q52).
-- sys_create_personal_workspace ignored the ceiling workspaces.ownMax and was kept while replicas of the release
-- before sys_create_personal_workspace_limited (430-workspace-limit.sql) still called it; the application calls only
-- the limited function. The statement runs in a migration marked with the contract header, and the function leaves
-- the system operation registry with it.
DROP FUNCTION IF EXISTS public.sys_create_personal_workspace(uuid, uuid, text);
