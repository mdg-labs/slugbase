import { type CSSProperties, type SubmitEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";

import { acceptInvite } from "../api/client.js";
import { useAuth } from "../auth/AuthContext.js";

const panelStyle: CSSProperties = {
  width: "100%",
  maxWidth: 400,
  margin: "10vh auto",
  padding: "var(--sp-8)",
  background: "var(--raised)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-lg)",
};

const inputStyle: CSSProperties = {
  width: "100%",
  marginTop: "var(--sp-2)",
  padding: "var(--sp-2) var(--sp-3)",
  background: "var(--base)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
};

const buttonStyle: CSSProperties = {
  width: "100%",
  marginTop: "var(--sp-4)",
  padding: "var(--sp-3)",
  background: "var(--accent)",
  color: "#0b0c14",
  border: "none",
  borderRadius: "var(--radius-sm)",
  fontWeight: 600,
};

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from =
    (location.state as { from?: string } | null)?.from ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user !== null) {
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
      void navigate(from, { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ padding: "var(--sp-6)" }}>
      <div style={panelStyle}>
        <h1 style={{ margin: 0, fontSize: "var(--text-xl)" }}>SlugBase Admin</h1>
        <p style={{ margin: "var(--sp-2) 0 var(--sp-6)", color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>
          Platform operator — not workspace admin
        </p>
        <form onSubmit={(event) => {
          void handleSubmit(event);
        }}>
          <label style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)" }}>
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              style={inputStyle}
            />
          </label>
          <label
            style={{
              display: "block",
              marginTop: "var(--sp-4)",
              fontSize: "var(--text-sm)",
              color: "var(--fg-muted)",
            }}
          >
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              style={inputStyle}
            />
          </label>
          {error !== null ? (
            <p style={{ margin: "var(--sp-3) 0 0", color: "var(--danger-text)", fontSize: "var(--text-sm)" }}>
              {error}
            </p>
          ) : null}
          <button type="submit" style={buttonStyle} disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

export function AcceptInvitePage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user !== null) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await acceptInvite(token, password);
      await refresh();
      void navigate("/", { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not accept invite");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ padding: "var(--sp-6)" }}>
      <div style={panelStyle}>
        <h1 style={{ margin: 0, fontSize: "var(--text-xl)" }}>Accept operator invite</h1>
        <p style={{ margin: "var(--sp-2) 0 var(--sp-6)", color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>
          Set a password to join the platform admin team.
        </p>
        <form onSubmit={(event) => {
          void handleSubmit(event);
        }}>
          <label
            style={{
              display: "block",
              fontSize: "var(--text-sm)",
              color: "var(--fg-muted)",
            }}
          >
            Password (min 12 characters)
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              style={inputStyle}
            />
          </label>
          <label
            style={{
              display: "block",
              marginTop: "var(--sp-4)",
              fontSize: "var(--text-sm)",
              color: "var(--fg-muted)",
            }}
          >
            Confirm password
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={confirm}
              onChange={(event) => {
                setConfirm(event.target.value);
              }}
              style={inputStyle}
            />
          </label>
          {error !== null ? (
            <p style={{ margin: "var(--sp-3) 0 0", color: "var(--danger-text)", fontSize: "var(--text-sm)" }}>
              {error}
            </p>
          ) : null}
          <button type="submit" style={buttonStyle} disabled={submitting || token.length === 0}>
            {submitting ? "Creating account…" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}
