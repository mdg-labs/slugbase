-- The contract half of the unlimited workspace function (doc 05 sections 3.3 and 5.2, Q52).
-- sys_create_workspace does not judge the ceiling workspaces.ownMax, and replicas of the release before
-- sys_create_workspace_limited (430-workspace-limit.sql) called it as slugbase_app. Nothing calls it as slugbase_app any
-- more: sys_complete_setup and sys_create_workspace_limited run as slugbase_system, which owns it. The statement runs in a
-- migration marked with the contract header; it takes the grant 120-setup.sql made in earlier releases away from
-- databases that hold it, and the function is an internal system operation in the registry (src/system/registry.ts).
REVOKE EXECUTE ON FUNCTION public.sys_create_workspace(uuid, uuid, text) FROM slugbase_app;
