import { type SubmitEvent, useState } from "react";

import { createInvite, listInvites, revokeInvite } from "../api/client.js";
import type { AdminInvite } from "../api/types.js";
import { ADMIN_ROLES } from "../auth/roles.js";
import { DataTable, type DataTableColumn } from "../components/DataTable.js";
import { ErrorRetry, InlineErrorRetry } from "../components/Feedback.js";
import { PageHeader } from "../components/PageHeader.js";
import { useAsyncData } from "../hooks/useAsyncData.js";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const inviteColumns = (
  onRevoke: (id: string) => void,
  revokingId: string | null,
): DataTableColumn<AdminInvite>[] => [
  { key: "email", header: "Email", render: (row) => row.email },
  { key: "role", header: "Role", mono: true, render: (row) => row.role },
  {
    key: "status",
    header: "Status",
    render: (row) => (row.acceptedAt ? "Accepted" : "Pending"),
  },
  {
    key: "expires",
    header: "Expires",
    render: (row) => formatDate(row.expiresAt),
  },
  {
    key: "actions",
    header: "",
    render: (row) =>
      row.acceptedAt ? (
        "—"
      ) : (
        <button
          type="button"
          onClick={() => {
            onRevoke(row.id);
          }}
          disabled={revokingId === row.id}
          style={{
            background: "none",
            border: "none",
            color: "var(--danger-text)",
            fontSize: "var(--text-xs)",
            padding: 0,
          }}
        >
          {revokingId === row.id ? "Revoking…" : "Revoke"}
        </button>
      ),
  },
];

export function OperatorInvitesPage() {
  const { data, loading, error, reload } = useAsyncData(() => listInvites(), []);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("viewer");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function handleCreate(event: SubmitEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await createInvite(email, role);
      setEmail("");
      reload();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Could not create invite");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(id: string) {
    setRevokingId(id);
    try {
      await revokeInvite(id);
      reload();
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Operator invites"
        subtitle="Invite platform operators — separate from workspace membership"
      />
      <form
        onSubmit={(event) => {
          void handleCreate(event);
        }}
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--sp-3)",
          alignItems: "flex-end",
          marginBottom: "var(--sp-6)",
          padding: "var(--sp-4)",
          background: "var(--raised)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-md)",
        }}
      >
        <label style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)" }}>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            style={{
              display: "block",
              marginTop: "var(--sp-1)",
              padding: "var(--sp-2) var(--sp-3)",
              background: "var(--base)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              minWidth: 240,
            }}
          />
        </label>
        <label style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)" }}>
          Role
          <select
            value={role}
            onChange={(event) => {
              setRole(event.target.value);
            }}
            style={{
              display: "block",
              marginTop: "var(--sp-1)",
              padding: "var(--sp-2) var(--sp-3)",
              background: "var(--base)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            {ADMIN_ROLES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: "var(--sp-2) var(--sp-4)",
            background: "var(--accent)",
            color: "#0b0c14",
            border: "none",
            borderRadius: "var(--radius-sm)",
            fontWeight: 500,
          }}
        >
          {submitting ? "Sending…" : "Create invite"}
        </button>
      </form>
      {formError !== null ? (
        <div style={{ marginBottom: "var(--sp-4)" }}>
          <InlineErrorRetry message={formError} onRetry={() => {
            setFormError(null);
          }} />
        </div>
      ) : null}
      {error !== null ? (
        <ErrorRetry message={error} onRetry={reload} />
      ) : (
        <DataTable
          columns={inviteColumns((id) => void handleRevoke(id), revokingId)}
          rows={data ?? []}
          rowKey={(row) => row.id}
          loading={loading}
          emptyTitle="No invites"
          emptyDescription="Create an invite to onboard a new platform operator."
        />
      )}
    </>
  );
}
