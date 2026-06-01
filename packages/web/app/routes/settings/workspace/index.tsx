import { useLoaderData } from "react-router";

import { WorkspaceSettingsPage } from "./components/WorkspaceSettingsPage.js";
import type { WorkspaceSettingsData } from "./workspace.types.js";

export { workspaceSettingsLoader as loader } from "./workspace-loader.js";

export default function WorkspaceSettingsRoute() {
  const data = useLoaderData<WorkspaceSettingsData>();
  return <WorkspaceSettingsPage initialData={data} />;
}
