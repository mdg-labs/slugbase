import { DangerZone, type DangerZoneItem } from "@slugbase/ui/patterns";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { DeleteAccountDialog } from "./delete-account-dialog.tsx";
import type { Account } from "./me.ts";

/** The `danger-zone` of `/settings/account` (doc 03 section 11.1): Delete account, with its typed confirmation. */
export function AccountDangerZone({ account }: { account: Account }): ReactElement {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);

  const items: readonly DangerZoneItem[] = [
    {
      id: "delete",
      title: t("settings.account.delete.item.title"),
      description: t("settings.account.delete.item.description"),
      actionLabel: t("settings.account.delete.action"),
      onSelect: () => {
        setDeleting(true);
      },
    },
  ];

  return (
    <>
      <DangerZone items={items} title={t("settings.account.danger.title")} />
      {deleting ? (
        <DeleteAccountDialog
          account={account}
          onClose={() => {
            setDeleting(false);
          }}
        />
      ) : null}
    </>
  );
}
