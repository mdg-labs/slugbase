import { getSessionUser } from "../../lib/session-client.js";
import { getServerApiBaseUrl } from "../../lib/server-api-base-url.js";

export interface SlugPreferenceItem {
  id: string;
  workspaceId: string;
  userId: string;
  slug: string;
  bookmarkId: string;
  createdAt: string;
  bookmarkTitle: string;
  bookmarkUrl: string;
  ownerUserId: string;
  isAmbiguous: boolean;
}

interface SlugPreferenceListResponse {
  items: SlugPreferenceItem[];
}

interface ShareTargetsResponse {
  members: Array<{ userId: string; name: string }>;
}

export interface ForwardingLoaderData {
  items: SlugPreferenceItem[];
  ownerNames: Record<string, string>;
  currentUserId: string;
}

export async function loadForwardingData(
  request: Request,
): Promise<ForwardingLoaderData | null> {
  const user = await getSessionUser(request);
  if (!user) return null;

  const cookie = request.headers.get("Cookie") ?? "";
  const apiBaseUrl = getServerApiBaseUrl();

  const res = await fetch(`${apiBaseUrl}/go/preferences`, {
    headers: cookie ? { Cookie: cookie } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;

  const body = (await res.json()) as SlugPreferenceListResponse;
  const items = body.items;

  const foreignOwnerIds = new Set(
    items
      .filter((item) => item.ownerUserId !== user.id)
      .map((item) => item.ownerUserId),
  );

  const ownerNames: Record<string, string> = {};
  if (foreignOwnerIds.size > 0) {
    const targetsRes = await fetch(`${apiBaseUrl}/sharing/targets`, {
      headers: cookie ? { Cookie: cookie } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (targetsRes.ok) {
      const targets = (await targetsRes.json()) as ShareTargetsResponse;
      for (const member of targets.members) {
        if (foreignOwnerIds.has(member.userId)) {
          ownerNames[member.userId] = member.name;
        }
      }
    }
  }

  return {
    items,
    ownerNames,
    currentUserId: user.id,
  };
}
