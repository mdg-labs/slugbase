import { useTranslation } from "react-i18next";
import { Button, Dialog, DialogContent } from "@slugbase/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  fetchResourceShares,
  fetchShareTargets,
  grantResourceShare,
  revokeResourceShare,
} from "./sharing-api.js";
import type { ShareGrant, ShareResourceKind } from "./sharing.types.js";

export type ShareDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceKind: ShareResourceKind;
  resourceId: string;
  resourceTitle: string;
  onUpdated?: () => void;
};

export function ShareDialog({
  open,
  onOpenChange,
  resourceKind,
  resourceId,
  resourceTitle,
  onUpdated,
}: ShareDialogProps) {
  const { t } = useTranslation();
  const [grants, setGrants] = useState<ShareGrant[]>([]);
  const [members, setMembers] = useState<
    Array<{ userId: string; name: string; email: string }>
  >([]);
  const [teams, setTeams] = useState<
    Array<{ id: string; name: string; memberCount: number }>
  >([]);
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [selectedKind, setSelectedKind] = useState<"user" | "team">("user");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grantedTargetIds = useMemo(() => {
    const users = new Set(
      grants.filter((grant) => grant.kind === "user").map((grant) => grant.targetId),
    );
    const teamIds = new Set(
      grants.filter((grant) => grant.kind === "team").map((grant) => grant.targetId),
    );
    return { users, teams: teamIds };
  }, [grants]);

  const loadDialog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [targets, nextGrants] = await Promise.all([
        fetchShareTargets(),
        fetchResourceShares(resourceKind, resourceId),
      ]);
      setMembers(targets.members);
      setTeams(targets.teams);
      setGrants(nextGrants);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sharing.dialog.load_error"));
    } finally {
      setLoading(false);
    }
  }, [resourceId, resourceKind, t]);

  useEffect(() => {
    if (!open) return;
    void loadDialog();
  }, [loadDialog, open]);

  const handleGrant = async () => {
    if (!selectedTargetId) return;
    setLoading(true);
    setError(null);
    try {
      await grantResourceShare(
        resourceKind,
        resourceId,
        selectedKind,
        selectedTargetId,
      );
      await loadDialog();
      setSelectedTargetId("");
      onUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sharing.dialog.grant_error"));
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async (grantId: string) => {
    setLoading(true);
    setError(null);
    try {
      await revokeResourceShare(resourceKind, resourceId, grantId);
      await loadDialog();
      onUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sharing.dialog.revoke_error"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        testId="share-dialog"
        title={t("sharing.dialog.title")}
        description={t("sharing.dialog.description", { title: resourceTitle })}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-sp-5 overflow-y-auto px-sp-8 py-sp-6">
          <div className="grid gap-sp-4 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
            <label className="grid gap-sp-2 text-small text-fg-muted">
              {t("sharing.dialog.target_kind_label")}
              <select
                className="rounded-md border border-[color:var(--border)] bg-[color:var(--raised)] px-sp-4 py-sp-3 text-fg"
                value={selectedKind}
                onChange={(event) => {
                  setSelectedKind(event.target.value as "user" | "team");
                  setSelectedTargetId("");
                }}
                data-testid="share-dialog-target-kind"
              >
                <option value="user">{t("sharing.dialog.target_kind_member")}</option>
                <option value="team">{t("sharing.dialog.target_kind_team")}</option>
              </select>
            </label>

            <label className="grid gap-sp-2 text-small text-fg-muted">
              {t("sharing.dialog.target_label")}
              <select
                className="rounded-md border border-[color:var(--border)] bg-[color:var(--raised)] px-sp-4 py-sp-3 text-fg"
                value={selectedTargetId}
                onChange={(event) => {
                  setSelectedTargetId(event.target.value);
                }}
                data-testid="share-dialog-target-select"
              >
                <option value="">{t("sharing.dialog.target_placeholder")}</option>
                {selectedKind === "user"
                  ? members
                      .filter((member) => !grantedTargetIds.users.has(member.userId))
                      .map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.name}
                        </option>
                      ))
                  : teams
                      .filter((team) => !grantedTargetIds.teams.has(team.id))
                      .map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
              </select>
            </label>

            <Button
              type="button"
              variant="primary"
              disabled={loading || !selectedTargetId}
              onClick={() => {
                void handleGrant();
              }}
              data-testid="share-dialog-grant-button"
            >
              {t("sharing.dialog.grant_action")}
            </Button>
          </div>

          {error ? (
            <p className="text-small text-[color:var(--danger-text)]" role="alert">
              {error}
            </p>
          ) : null}

          <div>
            <p className="mb-sp-3 text-small font-medium text-fg-muted">
              {t("sharing.dialog.current_grants_heading")}
            </p>
            {loading && grants.length === 0 ? (
              <p className="text-small text-fg-subtle">{t("sharing.dialog.loading")}</p>
            ) : grants.length === 0 ? (
              <p className="text-small text-fg-subtle" data-testid="share-dialog-empty">
                {t("sharing.dialog.empty_grants")}
              </p>
            ) : (
              <ul className="divide-y divide-[color:var(--border-subtle)] rounded-lg border border-[color:var(--border)]">
                {grants.map((grant) => (
                  <li
                    key={grant.id}
                    className="flex items-center gap-sp-4 px-sp-5 py-sp-4"
                    data-testid={`share-dialog-grant-${grant.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-fg">{grant.targetName}</p>
                      <p className="text-small text-fg-subtle">
                        {grant.kind === "user"
                          ? t("sharing.dialog.grant_kind_member")
                          : t("sharing.dialog.grant_kind_team")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={loading}
                      onClick={() => {
                        void handleRevoke(grant.id);
                      }}
                    >
                      {t("sharing.dialog.revoke_action")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex justify-end border-t border-[color:var(--border-subtle)] px-sp-8 py-sp-5">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t("sharing.dialog.close_action")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
