import { DangerZone, type DangerZoneItem } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { meQuery } from "../account/me.ts";
import { EndMembershipDialog } from "./end-membership-dialog.tsx";
import { useAllMembers } from "./use-all-members.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The `danger-zone` of `/settings/workspace` (doc 03 section 11.6): Leave workspace, with the content choice of
 * doc 02 section 3.6. The last owner cannot leave; the zone says so, and points at the members, where another
 * member is made an owner first.
 */
export function WorkspaceDangerZone({ workspace }: { workspace: Workspace }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const me = useQuery(meQuery(router.options.context.api));
  const all = useAllMembers();
  const [leaving, setLeaving] = useState(false);

  const viewerId = me.data?.account.id;
  const owner = workspace.role === "owner";
  const soleOwner = owner && viewerId !== undefined && all.complete && !all.members.some((member) => member.role === "owner" && member.accountId !== viewerId);
  // Whether another owner exists is known only once every member is in; the server refuses the last owner either way.
  const checking = owner && !all.complete && !all.failed;

  const items: readonly DangerZoneItem[] = [
    {
      id: "leave",
      title: t("settings.workspace.leave.item.title"),
      description: soleOwner ? (
        <>
          {t("settings.workspace.leave.lastOwner.text")}{" "}
          <Link className="text-foreground underline underline-offset-4" to="/settings/workspace/members">
            {t("settings.workspace.leave.lastOwner.link")}
          </Link>
        </>
      ) : (
        t("settings.workspace.leave.item.description")
      ),
      actionLabel: t("settings.workspace.leave.action"),
      disabled: viewerId === undefined || soleOwner || checking,
      onSelect: () => {
        setLeaving(true);
      },
    },
  ];

  return (
    <>
      <DangerZone
        items={items}
        title={t("settings.workspace.danger.title")}
      />
      {leaving && viewerId !== undefined ? (
        <EndMembershipDialog
          onClose={() => {
            setLeaving(false);
          }}
          target={{ kind: "leave", viewerId, workspaceName: workspace.name }}
        />
      ) : null}
    </>
  );
}
