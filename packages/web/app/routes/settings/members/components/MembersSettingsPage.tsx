import { useTranslate } from "@tolgee/react";
import { Button, ConfirmDialog, EmptyState, Input, Label } from "@slugbase/ui";
import { useMemo, useState } from "react";

import { useAppToast } from "../../../../components/feedback/AppToastProvider.js";
import { useAppLocale } from "../../../../i18n/use-app-locale.js";

import {
  addTeamMember,
  createInvitation,
  createTeam,
  deleteTeam,
  removeMember,
  removeTeamMember,
  resendInvitation,
  revokeInvitation,
  transferOwnership,
  updateMemberRole,
} from "../members-api.js";
import { canAccessMembersSettings, seatUsage } from "../members-entitlements.js";
import type {
  InvitationRole,
  MemberRole,
  MemberRow,
  MembersSettingsData,
  MembersTabId,
  TeamRow,
} from "../members.types.js";
import { MembersPlanGate } from "./MembersPlanGate.js";

function memberInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const first = parts[0];
    return first ? first.slice(0, 2).toUpperCase() : "?";
  }
  const first = parts[0];
  const second = parts[1];
  if (!first || !second) return "?";
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  const palette = ["#7782f7", "#45c98a", "#e6b24e", "#f0686b", "#5b66e8"];
  return palette[Math.abs(hash) % palette.length] ?? "#7782f7";
}

function formatDate(value: string, locale: string): string {
  return new Date(value).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function roleLabelKey(role: MemberRole | InvitationRole): string {
  if (role === "OWNER") return "settings.members.role_owner";
  if (role === "ADMIN") return "settings.members.role_admin";
  return "settings.members.role_member";
}

interface MembersSettingsPageProps {
  initialData: MembersSettingsData;
}

export function MembersSettingsPage({ initialData }: MembersSettingsPageProps) {
  const { t } = useTranslate();
  const [tab, setTab] = useState<MembersTabId>("members");
  const [members, setMembers] = useState(initialData.members);
  const [pending, setPending] = useState(initialData.pendingInvitations);
  const [teams, setTeams] = useState(initialData.teams);
  const [currentUserRole, setCurrentUserRole] = useState(initialData.currentUserRole);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitationRole>("MEMBER");
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<string | null>(null);
  const [teamCreateOpen, setTeamCreateOpen] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [teamDescription, setTeamDescription] = useState("");
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);
  const [teamDeleteTarget, setTeamDeleteTarget] = useState<TeamRow | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { showToast } = useAppToast();

  const locale = useAppLocale();
  const seats = useMemo(
    () => seatUsage(members.length, pending.length, initialData.workspace.planSeats),
    [members.length, pending.length, initialData.workspace.planSeats],
  );

  if (!canAccessMembersSettings(initialData.workspace.plan)) {
    return <MembersPlanGate />;
  }

  const isOwner = currentUserRole === "OWNER";
  const isAdmin = currentUserRole === "ADMIN" || isOwner;
  const ownerCount = members.filter((member) => member.role === "OWNER").length;

  const showError = (message: string) => {
    setErrorMessage(message);
  };

  const handleInvite = async () => {
    if (seats.atLimit || !inviteEmail.trim()) return;
    setBusy(true);
    try {
      const created = await createInvitation(
        initialData.workspace.id,
        inviteEmail.trim(),
        inviteRole,
      );
      setPending((items) => [
        ...items,
        {
          ...created,
          invitedByName: members.find((m) => m.userId === initialData.currentUserId)?.name ?? "",
        },
      ]);
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("MEMBER");
      showToast("settings.members.toast_invite_sent", { email: inviteEmail.trim() });
    } catch (err) {
      showError(err instanceof Error ? err.message : t("settings.members.error_generic"));
    } finally {
      setBusy(false);
    }
  };

  const handleRoleChange = async (member: MemberRow, nextRole: MemberRole | "TRANSFER") => {
    if (nextRole === "TRANSFER") {
      setTransferTarget(member.userId);
      return;
    }
    if (member.role === nextRole) return;
    setBusy(true);
    try {
      const updated = await updateMemberRole(member.userId, nextRole);
      setMembers((items) =>
        items.map((item) => (item.userId === updated.userId ? updated : item)),
      );
      showToast("settings.members.toast_role_updated");
    } catch (err) {
      showError(err instanceof Error ? err.message : t("settings.members.error_generic"));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (userId: string) => {
    setBusy(true);
    try {
      await removeMember(userId);
      setMembers((items) => items.filter((item) => item.userId !== userId));
      setRemoveTarget(null);
      showToast("settings.members.toast_member_removed");
    } catch (err) {
      showError(err instanceof Error ? err.message : t("settings.members.error_generic"));
    } finally {
      setBusy(false);
    }
  };

  const handleTransfer = async () => {
    if (!transferTarget) return;
    setBusy(true);
    try {
      const updatedMembers = await transferOwnership(transferTarget);
      setMembers(updatedMembers);
      const self = updatedMembers.find((m) => m.userId === initialData.currentUserId);
      if (self) setCurrentUserRole(self.role);
      setTransferTarget(null);
      const target = updatedMembers.find((m) => m.userId === transferTarget);
      showToast("settings.members.toast_ownership_transferred", {
        name: target?.name ?? "",
      });
    } catch (err) {
      showError(err instanceof Error ? err.message : t("settings.members.error_generic"));
    } finally {
      setBusy(false);
    }
  };

  const handleResend = async (invitationId: string, email: string) => {
    setBusy(true);
    try {
      const updated = await resendInvitation(invitationId);
      setPending((items) =>
        items.map((item) => (item.id === invitationId ? updated : item)),
      );
      showToast("settings.members.toast_invite_resent", { email });
    } catch (err) {
      showError(err instanceof Error ? err.message : t("settings.members.error_generic"));
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (invitationId: string) => {
    setBusy(true);
    try {
      await revokeInvitation(invitationId);
      setPending((items) => items.filter((item) => item.id !== invitationId));
      showToast("settings.members.toast_invite_revoked");
    } catch (err) {
      showError(err instanceof Error ? err.message : t("settings.members.error_generic"));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateTeam = async () => {
    if (!teamName.trim()) return;
    setBusy(true);
    try {
      const team = await createTeam(teamName.trim(), teamDescription.trim());
      setTeams((items) => [...items, team]);
      setTeamCreateOpen(false);
      setTeamName("");
      setTeamDescription("");
      showToast("settings.members.toast_team_created", { name: team.name });
    } catch (err) {
      showError(err instanceof Error ? err.message : t("settings.members.error_generic"));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteTeam = async (team: TeamRow) => {
    setBusy(true);
    try {
      await deleteTeam(team.id);
      setTeams((items) => items.filter((item) => item.id !== team.id));
      showToast("settings.members.toast_team_deleted", { name: team.name });
    } catch (err) {
      showError(err instanceof Error ? err.message : t("settings.members.error_generic"));
    } finally {
      setBusy(false);
    }
  };

  const handleAddTeamMember = async (teamId: string, userId: string) => {
    setBusy(true);
    try {
      const updated = await addTeamMember(teamId, userId);
      setTeams((items) => items.map((item) => (item.id === teamId ? updated : item)));
      showToast("settings.members.toast_team_member_added");
    } catch (err) {
      showError(err instanceof Error ? err.message : t("settings.members.error_generic"));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveTeamMember = async (teamId: string, userId: string) => {
    setBusy(true);
    try {
      const updated = await removeTeamMember(teamId, userId);
      setTeams((items) => items.map((item) => (item.id === teamId ? updated : item)));
      showToast("settings.members.toast_team_member_removed");
    } catch (err) {
      showError(err instanceof Error ? err.message : t("settings.members.error_generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[680px] px-sp-6 py-sp-8" data-testid="members-settings-page">
      <header className="mb-sp-8">
        <h1 className="m-0 text-[length:var(--text-body-lg)] font-semibold text-fg">
          {t("settings.members.page_title")}
        </h1>
        <p className="mt-sp-3 text-[length:var(--text-body)] text-fg-muted">
          {t("settings.members.page_subtitle", { workspace: initialData.workspace.name })}
        </p>
      </header>

      {errorMessage ? (
        <p
          className="mb-sp-5 rounded-md border border-[color:var(--danger-border)] bg-[color:var(--danger-subtle)] px-sp-5 py-sp-4 text-[length:var(--text-small)] text-fg"
          data-testid="members-error"
          role="alert"
        >
          {errorMessage}
        </p>
      ) : null}

      {seats.limit != null ? (
        <div className="mb-sp-8 rounded-lg border border-[color:var(--border-subtle)] bg-raised px-sp-5 py-sp-5">
          <div className="mb-sp-3 flex items-center justify-between gap-sp-4 text-[length:var(--text-small)] text-fg-muted">
            <span>
              {t("settings.members.seats_usage", {
                used: seats.used,
                limit: seats.limit,
              })}
            </span>
          </div>
          <div className="h-[5px] overflow-hidden rounded-full bg-canvas">
            <div
              className={`h-full rounded-full transition-all duration-normal ease-in-out ${
                seats.atLimit ? "bg-danger" : "bg-accent"
              }`}
              style={{
                width: `${String(Math.min(100, Math.round((seats.used / seats.limit) * 100)))}%`,
              }}
            />
          </div>
          {seats.atLimit ? (
            <p className="mt-sp-3 text-[length:var(--text-small)] text-danger-text">
              {t("settings.members.seats_at_limit")}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mb-sp-8 flex gap-sp-2 border-b border-[color:var(--border-subtle)]">
        {(["members", "teams"] as const).map((tabId) => (
          <button
            key={tabId}
            type="button"
            className={`border-b-2 px-sp-4 py-sp-3 text-[length:var(--text-body)] transition-colors duration-micro ${
              tab === tabId
                ? "border-accent text-fg"
                : "border-transparent text-fg-muted hover:text-fg"
            }`}
            onClick={() => {
              setTab(tabId);
            }}
          >
            {tabId === "members"
              ? t("settings.members.tab_members", { count: members.length })
              : t("settings.members.tab_teams", { count: teams.length })}
          </button>
        ))}
      </div>

      {tab === "members" ? (
        <section className="flex flex-col gap-sp-8">
          <div className="flex items-center justify-between gap-sp-4">
            <h2 className="m-0 text-[length:var(--text-body-lg)] font-semibold text-fg">
              {t("settings.members.members_heading", { count: members.length })}
            </h2>
            {isAdmin ? (
              <Button
                variant="primary"
                disabled={busy || seats.atLimit}
                onClick={() => {
                  setInviteOpen((open) => !open);
                }}
                type="button"
              >
                {t("settings.members.invite_action")}
              </Button>
            ) : null}
          </div>

          {inviteOpen && isAdmin ? (
            <div className="rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-5">
              <div className="flex flex-col gap-sp-4 md:flex-row md:items-end">
                <div className="flex-1">
                  <Label htmlFor="invite-email">{t("settings.members.invite_email_label")}</Label>
                  <Input
                    id="invite-email"
                    value={inviteEmail}
                    onChange={(event) => {
                      setInviteEmail(event.target.value);
                    }}
                    placeholder={t("settings.members.invite_email_placeholder")}
                    disabled={busy || seats.atLimit}
                  />
                </div>
                <div>
                  <Label htmlFor="invite-role">{t("settings.members.invite_role_label")}</Label>
                  <select
                    id="invite-role"
                    className="w-full rounded-md border border-[color:var(--border)] bg-base px-sp-4 py-sp-3 text-[length:var(--text-body)] text-fg"
                    value={inviteRole}
                    onChange={(event) => {
                      setInviteRole(event.target.value as InvitationRole);
                    }}
                    disabled={busy || seats.atLimit}
                  >
                    <option value="MEMBER">{t("settings.members.role_member")}</option>
                    <option value="ADMIN">{t("settings.members.role_admin")}</option>
                  </select>
                </div>
                <div className="flex gap-sp-3">
                  <Button
                    disabled={busy || !inviteEmail.trim() || seats.atLimit}
                    onClick={() => {
                      void handleInvite();
                    }}
                    type="button"
                  >
                    {t("settings.members.invite_send_action")}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setInviteOpen(false);
                    }}
                    type="button"
                  >
                    {t("settings.members.cancel_action")}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="divide-y divide-[color:var(--border-subtle)] border-t border-[color:var(--border-subtle)]">
            {members.map((member) => {
              const canEditRole = isOwner && !(member.role === "OWNER" && ownerCount <= 1);
              const canRemove = isAdmin && member.role !== "OWNER";

              return (
                <div key={member.id}>
                  <div className="flex flex-wrap items-center gap-sp-4 py-sp-4">
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-full text-[length:var(--text-small)] font-medium text-[#0b0c14]"
                      style={{ backgroundColor: avatarColor(member.email) }}
                    >
                      {memberInitials(member.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-sp-3">
                        <span className="font-medium text-fg">{member.name}</span>
                        {member.role === "OWNER" ? (
                          <span className="rounded-full bg-[color:var(--accent-subtle)] px-sp-3 py-sp-1 text-[length:var(--text-small)] text-accent-text">
                            {t("settings.members.role_owner")}
                          </span>
                        ) : null}
                      </div>
                      <div className="font-mono text-[length:var(--text-small)] text-fg-muted">
                        {member.email}
                      </div>
                    </div>
                    <span className="text-[length:var(--text-small)] text-fg-subtle">
                      {formatDate(member.joinedAt, locale)}
                    </span>
                    {canEditRole ? (
                      <select
                        className="rounded-md border border-[color:var(--border)] bg-base px-sp-3 py-sp-2 text-[length:var(--text-small)]"
                        value={member.role === "OWNER" ? "OWNER" : member.role}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (value === "TRANSFER") {
                            void handleRoleChange(member, "TRANSFER");
                            return;
                          }
                          void handleRoleChange(member, value as MemberRole);
                        }}
                        disabled={busy || member.role === "OWNER"}
                      >
                        <option value="MEMBER">{t("settings.members.role_member")}</option>
                        <option value="ADMIN">{t("settings.members.role_admin")}</option>
                        {member.role !== "OWNER" ? (
                          <option value="TRANSFER">{t("settings.members.role_transfer_option")}</option>
                        ) : null}
                        {member.role === "OWNER" ? (
                          <option value="OWNER">{t("settings.members.role_owner")}</option>
                        ) : null}
                      </select>
                    ) : (
                      <span className="text-[length:var(--text-small)] text-fg-muted">
                        {t(roleLabelKey(member.role))}
                      </span>
                    )}
                    {canRemove ? (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setRemoveTarget(member.userId);
                        }}
                        type="button"
                      >
                        {t("settings.members.remove_action")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          {pending.length > 0 ? (
            <div>
              <h3 className="mb-sp-5 text-[length:var(--text-body-lg)] font-semibold text-fg">
                {t("settings.members.pending_heading", { count: pending.length })}
              </h3>
              <div className="divide-y divide-[color:var(--border-subtle)] border-t border-[color:var(--border-subtle)]">
                {pending.map((invitation) => (
                  <div key={invitation.id} className="flex flex-wrap items-center gap-sp-4 py-sp-4">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[length:var(--text-small)] text-fg">
                        {invitation.invitedEmail}
                      </div>
                      <div className="text-[length:var(--text-small)] text-fg-subtle">
                        {t("settings.members.pending_meta", {
                          inviter: invitation.invitedByName,
                          expiry: formatDate(invitation.expiresAt, locale),
                        })}
                      </div>
                    </div>
                    <span className="rounded-full bg-raised-2 px-sp-3 py-sp-1 text-[length:var(--text-small)] text-fg-muted">
                      {t(roleLabelKey(invitation.role))}
                    </span>
                    {isAdmin ? (
                      <>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void handleResend(invitation.id, invitation.invitedEmail)
                          }
                          type="button"
                        >
                          {t("settings.members.resend_action")}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            void handleRevoke(invitation.id);
                          }}
                          type="button"
                        >
                          {t("settings.members.revoke_action")}
                        </Button>
                      </>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : (
        <section className="flex flex-col gap-sp-6">
          <div className="flex items-center justify-between gap-sp-4">
            <h2 className="m-0 text-[length:var(--text-body-lg)] font-semibold text-fg">
              {t("settings.members.teams_heading", { count: teams.length })}
            </h2>
            {isAdmin ? (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  setTeamCreateOpen((value) => !value);
                }}
                type="button"
              >
                {t("settings.members.team_create_action")}
              </Button>
            ) : null}
          </div>

          {teamCreateOpen && isAdmin ? (
            <div className="rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-5">
              <div className="flex flex-col gap-sp-4">
                <div>
                  <Label htmlFor="team-name">{t("settings.members.team_name_label")}</Label>
                  <Input
                    id="team-name"
                    value={teamName}
                    onChange={(event) => {
                      setTeamName(event.target.value);
                    }}
                    placeholder={t("settings.members.team_name_placeholder")}
                  />
                </div>
                <div>
                  <Label htmlFor="team-description">{t("settings.members.team_description_label")}</Label>
                  <Input
                    id="team-description"
                    value={teamDescription}
                    onChange={(event) => {
                      setTeamDescription(event.target.value);
                    }}
                    placeholder={t("settings.members.team_description_placeholder")}
                  />
                </div>
                <div className="flex gap-sp-3">
                  <Button
                    disabled={busy || !teamName.trim()}
                    onClick={() => {
                      void handleCreateTeam();
                    }}
                    type="button"
                  >
                    {t("settings.members.team_create_submit")}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setTeamCreateOpen(false);
                    }}
                    type="button"
                  >
                    {t("settings.members.cancel_action")}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {teams.length === 0 && !teamCreateOpen ? (
            <EmptyState
              compact
              title={t("settings.members.teams_empty")}
              testId="members-teams-empty"
            />
          ) : null}

          {teams.map((team) => (
            <div
              key={team.id}
              className="rounded-lg border border-[color:var(--border-subtle)] bg-raised"
            >
              <div className="flex items-start justify-between gap-sp-4 p-sp-5">
                <div>
                  <h3 className="m-0 text-[length:var(--text-body)] font-semibold text-fg">{team.name}</h3>
                  {team.description ? (
                    <p className="mt-sp-2 text-[length:var(--text-small)] text-fg-muted">
                      {team.description}
                    </p>
                  ) : null}
                </div>
                <div className="flex gap-sp-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setExpandedTeamId((current) => (current === team.id ? null : team.id));
                    }}
                    type="button"
                  >
                    {expandedTeamId === team.id
                      ? t("settings.members.team_collapse_action")
                      : t("settings.members.team_expand_action")}
                  </Button>
                  {isAdmin ? (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setTeamDeleteTarget(team);
                      }}
                      type="button"
                    >
                      {t("settings.members.team_delete_action")}
                    </Button>
                  ) : null}
                </div>
              </div>
              {expandedTeamId === team.id ? (
                <div className="border-t border-[color:var(--border-subtle)] p-sp-5">
                  <div className="flex flex-wrap gap-sp-3">
                    {team.memberIds.map((userId) => {
                      const member = members.find((item) => item.userId === userId);
                      if (!member) return null;
                      return (
                        <div
                          key={userId}
                          className="flex items-center gap-sp-3 rounded-full bg-base px-sp-4 py-sp-2 text-[length:var(--text-small)] text-fg-muted"
                        >
                          <span>{member.name}</span>
                          {isAdmin ? (
                            <button
                              type="button"
                              className="text-danger-text"
                              disabled={busy}
                              onClick={() => {
                                void handleRemoveTeamMember(team.id, userId);
                              }}
                            >
                              {t("settings.members.team_member_remove_action")}
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  {isAdmin ? (
                    <div className="mt-sp-4">
                      <Label htmlFor={`team-add-${team.id}`}>
                        {t("settings.members.team_add_member_label")}
                      </Label>
                      <select
                        id={`team-add-${team.id}`}
                        className="mt-sp-2 w-full rounded-md border border-[color:var(--border)] bg-base px-sp-4 py-sp-3 text-[length:var(--text-body)]"
                        defaultValue=""
                        disabled={busy}
                        onChange={(event) => {
                          const userId = event.target.value;
                          if (!userId) return;
                          void handleAddTeamMember(team.id, userId);
                          event.target.value = "";
                        }}
                      >
                        <option value="">{t("settings.members.team_add_member_placeholder")}</option>
                        {members
                          .filter((member) => !team.memberIds.includes(member.userId))
                          .map((member) => (
                            <option key={member.userId} value={member.userId}>
                              {member.name}
                            </option>
                          ))}
                      </select>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </section>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={t("settings.members.remove_confirm_action")}
        description={t("settings.members.remove_confirm_body", {
          name: members.find((member) => member.userId === removeTarget)?.name ?? "",
        })}
        confirmLabel={t("settings.members.remove_confirm_action")}
        cancelLabel={t("settings.members.cancel_action")}
        destructive
        busy={busy}
        onConfirm={() => {
          if (removeTarget) {
            void handleRemove(removeTarget);
            setRemoveTarget(null);
          }
        }}
        testId="members-remove-confirm"
      />

      <ConfirmDialog
        open={transferTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTransferTarget(null);
        }}
        title={t("settings.members.transfer_confirm_action")}
        description={t("settings.members.transfer_confirm_body", {
          name: members.find((member) => member.userId === transferTarget)?.name ?? "",
        })}
        confirmLabel={t("settings.members.transfer_confirm_action")}
        cancelLabel={t("settings.members.cancel_action")}
        busy={busy}
        onConfirm={() => {
          void handleTransfer();
        }}
        testId="members-transfer-confirm"
      />

      <ConfirmDialog
        open={teamDeleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTeamDeleteTarget(null);
        }}
        title={t("settings.members.team_delete_confirm_title")}
        description={t("settings.members.team_delete_confirm_body", {
          name: teamDeleteTarget?.name ?? "",
        })}
        confirmLabel={t("settings.members.team_delete_action")}
        cancelLabel={t("settings.members.cancel_action")}
        destructive
        busy={busy}
        onConfirm={() => {
          if (teamDeleteTarget) {
            void handleDeleteTeam(teamDeleteTarget);
            setTeamDeleteTarget(null);
          }
        }}
        testId="members-team-delete-confirm"
      />
    </div>
  );
}
