import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { getSessionUser } from "../../../lib/session-client.js";
import { loadMembersSettingsData } from "./members-api.js";
import type { MembersSettingsData } from "./members.types.js";

export async function membersSettingsLoader({
  request,
}: LoaderFunctionArgs): Promise<MembersSettingsData> {
  const user = await getSessionUser(request);
  if (!user) {
    return redirect("/login") as never;
  }

  const data = await loadMembersSettingsData(request, user.id);
  if (!data) {
    throw new Error("Failed to load members settings data");
  }

  return {
    ...data,
    currentUserId: user.id,
  };
}
