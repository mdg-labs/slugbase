import { ChevronsUpDownIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../components/ui/menu.tsx";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../components/ui/sidebar.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { AccountAvatar } from "./account-avatar.tsx";

/** A workspace the menu lists. */
export interface WorkspaceSwitcherItem {
  id: string;
  name: string;
}

/** An action below the list of workspaces, such as creating one. */
export interface WorkspaceSwitcherAction {
  /** Keys the action. */
  id: string;
  label: string;
  /** A decorative icon. */
  icon?: ReactNode;
  onSelect: () => void;
}

/** What the workspace switcher in the sidebar header shows and does; the app passes it to {@link AppShell}. */
export interface WorkspaceSwitcherProps {
  /** The workspace the account acts in; absent while it has none. */
  active: WorkspaceSwitcherItem | undefined;
  /** Written in place of the name while there is no active workspace. */
  fallbackName: string;
  /** Names the button that opens the menu; the active workspace's name follows it. */
  label: string;
  /** Whether the active workspace is still being looked up. */
  loading?: boolean;
  /** Under the name: the plan label an extension fills. Nothing is drawn for an absent one. */
  plan?: ReactNode;
  /** Switching is under way: the button cannot open the menu. */
  disabled?: boolean;
  groupLabel: string;
  /** The account's workspaces, as far as `listState` has them. */
  workspaces: readonly WorkspaceSwitcherItem[];
  /** Where the list of workspaces stands: asked for, answered, or failed. A failed list is never shown as an empty one. */
  listState: "loading" | "ready" | "error";
  loadingLabel: string;
  errorMessage: string;
  retryLabel: string;
  onRetry: () => void;
  /** Said under the list when the active workspace is the only one. */
  emptyMessage: string;
  onSelect: (workspaceId: string) => void;
  actions: readonly WorkspaceSwitcherAction[];
}

/**
 * The workspace switcher in the sidebar header (doc 03 "App shell"): the active workspace's monogram and
 * name, and a menu of the account's workspaces with a check on the active one, followed by the actions.
 * It is part of {@link AppShell}, which draws it when given the props.
 */
export function WorkspaceSwitcher({
  active,
  fallbackName,
  label,
  loading = false,
  plan,
  disabled = false,
  groupLabel,
  workspaces,
  listState,
  loadingLabel,
  errorMessage,
  retryLabel,
  onRetry,
  emptyMessage,
  onSelect,
  actions,
}: WorkspaceSwitcherProps): ReactElement {
  if (loading) {
    return (
      <div aria-busy="true" aria-label={loadingLabel} className="flex h-12 items-center gap-2 px-2" role="status">
        <Skeleton className="size-8 shrink-0 rounded-lg" />
        <Skeleton className="h-4 flex-1 group-data-[collapsible=icon]:hidden" />
      </div>
    );
  }
  const name = active?.name ?? fallbackName;
  const alone = workspaces.every(({ id }) => id === active?.id);
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Menu>
          <MenuTrigger disabled={disabled} render={<SidebarMenuButton aria-label={`${label}: ${name}`} size="lg" />}>
            <AccountAvatar className="rounded-lg" name={name} seed={active?.id ?? name} size="sm" />
            <span className="min-w-0 flex-1 truncate font-medium group-data-[collapsible=icon]:hidden">{name}</span>
            <ChevronsUpDownIcon aria-hidden="true" className="ms-auto opacity-60 group-data-[collapsible=icon]:hidden" />
          </MenuTrigger>
          <MenuPopup align="start" className="w-64 max-w-[calc(100vw-2rem)]">
            <MenuGroup>
              <MenuGroupLabel>{groupLabel}</MenuGroupLabel>
              {listState === "loading" ? (
                <div aria-busy="true" aria-label={loadingLabel} className="flex flex-col gap-2 px-2 py-1.5" role="status">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ) : null}
              {listState === "error" ? (
                <>
                  <p className="px-2 py-1.5 text-destructive-text text-sm" role="alert">
                    {errorMessage}
                  </p>
                  <MenuItem closeOnClick={false} onClick={onRetry}>
                    {retryLabel}
                  </MenuItem>
                </>
              ) : null}
              {listState === "ready" ? (
                <>
                  <MenuRadioGroup
                    onValueChange={(value: string) => {
                      if (value !== active?.id) {
                        onSelect(value);
                      }
                    }}
                    value={active?.id ?? ""}
                  >
                    {workspaces.map((workspace) => (
                      <MenuRadioItem key={workspace.id} value={workspace.id}>
                        <span className="truncate">{workspace.name}</span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                  {alone ? <p className="px-2 py-1.5 text-muted-foreground text-xs">{emptyMessage}</p> : null}
                </>
              ) : null}
            </MenuGroup>
            {actions.length === 0 ? null : <MenuSeparator />}
            {actions.map(({ id, label: actionLabel, icon, onSelect: select }) => (
              <MenuItem key={id} onClick={select}>
                {icon}
                {actionLabel}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
        {plan === undefined ? null : <div className="-mt-1 mb-1 ps-12 text-muted-foreground text-xs group-data-[collapsible=icon]:hidden">{plan}</div>}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
