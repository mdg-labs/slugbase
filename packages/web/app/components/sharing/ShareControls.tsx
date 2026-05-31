import { useTranslate } from "@tolgee/react";
import { Button } from "@slugbase/ui";
import { useState } from "react";

import { ShareDialog } from "./ShareDialog.js";
import type { ShareResourceKind } from "./sharing.types.js";
import { useWorkspaceEntitlements } from "./use-workspace-entitlements.js";

export type ShareControlsProps = {
  resourceKind: ShareResourceKind;
  resourceId: string;
  resourceTitle: string;
  ownerUserId: string;
  onUpdated?: () => void;
  compact?: boolean;
};

export function ShareControls({
  resourceKind,
  resourceId,
  resourceTitle,
  ownerUserId,
  onUpdated,
  compact = false,
}: ShareControlsProps) {
  const { t } = useTranslate();
  const { canShare, currentUserId } = useWorkspaceEntitlements();
  const [open, setOpen] = useState(false);

  if (!canShare || ownerUserId !== currentUserId) {
    return null;
  }

  return (
    <>
      <Button
        type="button"
        variant={compact ? "ghost" : "secondary"}
        onClick={() => {
          setOpen(true);
        }}
        data-testid={`share-controls-${resourceKind}-${resourceId}`}
      >
        {t("sharing.controls.share_action")}
      </Button>
      <ShareDialog
        open={open}
        onOpenChange={setOpen}
        resourceKind={resourceKind}
        resourceId={resourceId}
        resourceTitle={resourceTitle}
        onUpdated={onUpdated}
      />
    </>
  );
}
