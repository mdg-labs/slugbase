import type { StoryDefault } from "@ladle/react";
import { BookmarkIcon, FolderIcon, PlusIcon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from "../src/index.ts";

export default {
  title: "Sidebar",
  parameters: { subject: ["Sidebar", "SidebarContent", "SidebarFooter", "SidebarGroup", "SidebarGroupAction", "SidebarGroupContent", "SidebarGroupLabel", "SidebarHeader", "SidebarInput", "SidebarInset", "SidebarMenu", "SidebarMenuAction", "SidebarMenuBadge", "SidebarMenuButton", "SidebarMenuItem", "SidebarMenuSkeleton", "SidebarMenuSub", "SidebarMenuSubButton", "SidebarMenuSubItem", "SidebarProvider", "SidebarRail", "SidebarSeparator", "SidebarTrigger"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <SidebarProvider className="min-h-96">
    <Sidebar>
      <SidebarHeader>
        <SidebarInput aria-label="Search" placeholder="Search" />
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Library</SidebarGroupLabel>
          <SidebarGroupAction aria-label="Add folder">
            <PlusIcon aria-hidden="true" />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive render={<a href="/bookmarks" />}>
                  <BookmarkIcon aria-hidden="true" />
                  Bookmarks
                </SidebarMenuButton>
                <SidebarMenuBadge>12</SidebarMenuBadge>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<a href="/folders" />}>
                  <FolderIcon aria-hidden="true" />
                  Folders
                </SidebarMenuButton>
                <SidebarMenuAction aria-label="Add folder">
                  <PlusIcon aria-hidden="true" />
                </SidebarMenuAction>
                <SidebarMenuSub>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton render={<a href="/folders/reading" />}>Reading</SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                </SidebarMenuSub>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuSkeleton showIcon />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
    <SidebarInset>
      <SidebarTrigger aria-label="Toggle sidebar" />
      <p>Content</p>
    </SidebarInset>
  </SidebarProvider>
);

export const Collapsed = (): React.ReactElement => (
  <SidebarProvider className="min-h-96" defaultOpen={false}>
    <Sidebar>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Library</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton render={<a href="/bookmarks" />}>Bookmarks</SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
    <SidebarInset>
      <SidebarTrigger aria-label="Toggle sidebar" />
      <p>Content</p>
    </SidebarInset>
  </SidebarProvider>
);
