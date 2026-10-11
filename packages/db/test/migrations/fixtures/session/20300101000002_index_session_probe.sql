-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY session_probe_login_role_idx ON session_probe (login_role);
