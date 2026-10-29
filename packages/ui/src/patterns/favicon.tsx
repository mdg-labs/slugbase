import { useState, type ReactElement, type SyntheticEvent } from "react";
import { cn } from "../lib/utils.ts";
import { avatarColour } from "./account-avatar.tsx";

export interface FaviconProps {
  /** The host of the bookmark, as the API names it (lower case, in punycode). The icon comes from the app's own `/api/v1/favicons/<host>`, never from the site. */
  host: string;
  /** The edge of the icon in pixels. */
  size?: 16 | 32;
  className?: string;
}

const FAVICON_PATH = "/api/v1/favicons/";
const HOST_MAX_LENGTH = 253;
const LABEL_MAX_LENGTH = 63;

const BOX = { 16: "size-4 rounded-sm text-micro", 32: "size-8 rounded-md text-sm" } as const;

/** Whether the text is a host name: dot-separated labels of 1 to 63 letters, digits and hyphens that neither start nor end with a hyphen. */
function isHostName(host: string): boolean {
  return (
    host.length <= HOST_MAX_LENGTH &&
    host.split(".").every((label) => label.length <= LABEL_MAX_LENGTH && /^[a-z0-9-]+$/.test(label) && !label.startsWith("-") && !label.endsWith("-"))
  );
}

/** The first letter of the host without a leading `www.`: the stand-in for an icon that does not exist. */
function monogramOf(host: string): string {
  return Array.from(host.replace(/^www\./i, ""))[0] ?? "";
}

type Status = "loading" | "loaded" | "missing";

function FaviconFrame({ host, size, className }: { host: string; size: 16 | 32; className: string | undefined }): ReactElement {
  const requestable = isHostName(host);
  const [status, setStatus] = useState<Status>(requestable ? "loading" : "missing");
  const loaded = status === "loaded";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative grid shrink-0 select-none place-items-center overflow-hidden font-medium uppercase",
        BOX[size],
        loaded ? "bg-muted" : cn("text-background", avatarColour(host)),
        className,
      )}
      data-slot="favicon"
      data-state={status}
      translate="no"
    >
      {loaded ? null : monogramOf(host)}
      {status === "missing" ? null : (
        <img
          alt=""
          className={cn("absolute inset-0 size-full object-contain", loaded ? undefined : "opacity-0")}
          decoding="async"
          height={size}
          loading="lazy"
          onError={() => {
            setStatus("missing");
          }}
          onLoad={(event: SyntheticEvent<HTMLImageElement>) => {
            // The answer for a host without a stored icon is a transparent PNG of one pixel; the stored icons are 32 and 64 pixels wide.
            setStatus(event.currentTarget.naturalWidth > 1 ? "loaded" : "missing");
          }}
          src={`${FAVICON_PATH}${host}`}
          width={size}
        />
      )}
    </span>
  );
}

/**
 * The icon of a bookmark's host (doc 03 "Component system", doc 02 section 5.4): the one place an icon `<img>` is created. The picture is the app's
 * own favicon proxy, so the browser never contacts the bookmarked site (doc 10 T6, T14), and the content security policy for images stays `'self'`.
 * The box has its final size from the first render and shows the host's monogram, a letter on a colour derived from the host, while the icon loads
 * and instead of it when the host has none, when the request fails or when the host is not a host name. It is decorative, so it has no text alternative.
 */
export function Favicon({ host, size = 16, className }: FaviconProps): ReactElement {
  const name = host.toLowerCase();
  return <FaviconFrame className={className} host={name} key={name} size={size} />;
}
