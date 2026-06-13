import { useLoaderData } from "react-router";

import type { MembersSettingsData } from "./members.types.js";
import { MembersSettingsPage } from "./components/MembersSettingsPage.js";

export { membersSettingsLoader as loader } from "./members-loader.js";

export default function MembersSettingsRoute() {
  const data = useLoaderData<MembersSettingsData>();
  return <MembersSettingsPage initialData={data} />;
}
