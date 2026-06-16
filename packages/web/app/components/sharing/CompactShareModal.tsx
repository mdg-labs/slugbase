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

export type CompactShareModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceKind: ShareResourceKind;
  resourceId: string;
  resourceTitle: string;
  onUpdated?: () => void;
};

export function CompactShareModal({
  open,
  onOpenChange,
  resourceKind,
  resourceId,
  resourceTitle,
  onUpdated,
}: CompactShareModalProps) {
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
  const [loadingGrants, setLoadingGrants] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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
    setLoadingGrants(true);
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
      setError(err instanceof Error ? err.message : t("sharing.compact.load_error"));
    } finally {
      setLoadingGrants(false);
    }
  }, [resourceId, resourceKind, t]);

  useEffect(() => {
    if (!open) return;
    void loadDialog();
  }, [loadDialog, open]);

  const handleGrant = async () => {
    if (!selectedTargetId) return;
    setSubmitting(true);
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
      setError(err instanceof Error ? err.message : t("sharing.compact.grant_error"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async (grantId: string) => {
    setSubmitting(true);
    setError(null);
    try {
      await revokeResourceShare(resourceKind, resourceId, grantId);
      await loadDialog();
      onUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sharing.compact.revoke_error"));
    } finally {
      setSubmitting(false);
    }
  };

  const grantDisabled = submitting || !selectedTargetId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        testId="compact-share-modal"
        title={t("sharing.compact.title")}
        description={t("sharing.compact.description", { title: resourceTitle })}
        className="w-[min(420px,92vw)]"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-sp-4 overflow-y-auto px-sp-6 py-sp-5">
          <div className="grid gap-sp-3">
            <label className="grid gap-sp-2 text-small text-fg-muted">
              {t("sharing.compact.target_kind_label")}
              <select
                className="rounded-md border border-[color:var(--border)] bg-[color:var(--raised)] px-sp-4 py-sp-3 text-fg"
                value={selectedKind}
                onChange={(event) => {
                  setSelectedKind(event.target.value as "user" | "team");
                  setSelectedTargetId("");
                }}
                aria-label={t("sharing.compact.target_kind_label")}
                data-testid="compact-share-modal-target-kind"
              >
                <option value="user">{t("sharing.compact.target_kind_member")}</option>
                <option value="team">{t("sharing.compact.target_kind_team")}</option>
              </select>
            </label>

            <label className="grid gap-sp-2 text-small text-fg-muted">
              {t("sharing.compact.target_label")}
              <select
                className="rounded-md border border-[color:var(--border)] bg-[color:var(--raised)] px-sp-4 py-sp-3 text-fg"
                value={selectedTargetId}
                onChange={(event) => {
                  setSelectedTargetId(event.target.value);
                }}
                aria-label={t("sharing.compact.target_label")}
                data-testid="compact-share-modal-target-select"
              >
                <option value="">{t("sharing.compact.target_placeholder")}</option>
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
              disabled={grantDisabled}
              onClick={() => {
                void handleGrant();
              }}
              data-testid="compact-share-modal-grant-button"
            >
              {t("sharing.compact.grant_action")}
            </Button>
          </div>

          {error ? (
            <p className="text-small text-[color:var(--danger-text)]" role="alert">
              {error}
            </p>
          ) : null}

          <div>
            <p className="mb-sp-3 text-small font-medium text-fg-muted">
              {t("sharing.compact.current_grants_heading")}
            </p>
            {loadingGrants && grants.length === 0 ? (
              <p className="text-small text-fg-subtle">{t("sharing.compact.loading")}</p>
            ) : grants.length === 0 ? (
              <p
                className="text-small text-fg-subtle"
                data-testid="compact-share-modal-empty"
              >
                {t("sharing.compact.empty_grants")}
              </p>
            ) : (
              <ul className="divide-y divide-[color:var(--border-subtle)] rounded-lg border border-[color:var(--border)]">
                {grants.map((grant) => (
                  <li
                    key={grant.id}
                    className="flex items-center gap-sp-3 px-sp-4 py-sp-3"
                    data-testid={`compact-share-modal-grant-${grant.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-fg">{grant.targetName}</p>
                      <p className="text-small text-fg-subtle">
                        {grant.kind === "user"
                          ? t("sharing.compact.grant_kind_member")
                          : t("sharing.compact.grant_kind_team")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={submitting}
                      aria-label={t("sharing.compact.revoke_action")}
                      onClick={() => {
                        void handleRevoke(grant.id);
                      }}
                      data-testid={`compact-share-modal-revoke-${grant.id}`}
                    >
                      {t("sharing.compact.revoke_action")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex justify-end border-t border-[color:var(--border-subtle)] px-sp-6 py-sp-4">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
            data-testid="compact-share-modal-done"
          >
            {t("sharing.compact.done_action")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
