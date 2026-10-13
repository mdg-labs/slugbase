import type { StoryDefault } from "@ladle/react";
import { HomeIcon } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  ThemeProvider,
} from "../../src/index.ts";
import { AppShell, ThemeToggle, type AppShellLabels } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/App shell",
  parameters: { subject: ["AppShell"] },
} satisfies StoryDefault;

const labels: AppShellLabels = {
  skipToContent: "Skip to content",
  toggleSidebar: "Toggle sidebar",
  navigation: "Main",
  drawerTitle: "Navigation",
  drawerDescription: "The pages of the app.",
  drawerClose: "Close navigation",
};

const Shell = ({ defaultOpen }: { defaultOpen: boolean }): React.ReactElement => (
  <ThemeProvider>
    <AppShell
      actions={<ThemeToggle switchToDark="Switch to dark theme" switchToLight="Switch to light theme" />}
      breadcrumb={
        <Breadcrumb aria-label="Breadcrumb">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>Home</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      }
      defaultOpen={defaultOpen}
      footer={<a href="https://slugbase.app/docs">Help &amp; docs</a>}
      labels={labels}
      navigation={
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive render={<a href="/" />} tooltip="Home">
              <HomeIcon aria-hidden="true" />
              <span>Home</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      }
      productName="SlugBase"
    >
      <p className="p-6">Page</p>
    </AppShell>
  </ThemeProvider>
);

export const Expanded = (): React.ReactElement => <Shell defaultOpen />;

export const Collapsed = (): React.ReactElement => <Shell defaultOpen={false} />;
