import { useState } from "react";

type BookmarkFaviconProps = {
  url: string;
  size?: number;
  className?: string;
};

/**
 * Renders a favicon proxied through GET /bookmarks/favicon?url=<url>.
 * Falls back to an initial-letter monogram if the favicon fails to load.
 */
export function BookmarkFavicon({
  url,
  size = 32,
  className = "",
}: BookmarkFaviconProps) {
  const [failed, setFailed] = useState(false);

  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = url.slice(0, 1);
  }
  const initial = hostname.replace(/^www\./, "").slice(0, 1).toUpperCase();

  if (failed || !url) {
    return (
      <span
        className={[
          "inline-flex shrink-0 items-center justify-center rounded-md bg-[color:var(--raised-2)] font-mono font-semibold text-fg-subtle",
          className,
        ].join(" ")}
        style={{
          width: size,
          height: size,
          fontSize: Math.max(10, Math.round(size * 0.44)),
        }}
        aria-hidden
      >
        {initial}
      </span>
    );
  }

  const src = `/bookmarks/favicon?url=${encodeURIComponent(url)}`;

  return (
    <img
      src={src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={["shrink-0 rounded-md object-contain", className].join(" ")}
      style={{ width: size, height: size }}
      onError={() => {
        setFailed(true);
      }}
    />
  );
}
