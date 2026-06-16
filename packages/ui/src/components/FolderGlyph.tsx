import { LucideIcon } from "../icons/lucide-icon.js";

export type FolderGlyphProps = {
  icon: string | null;
  color: string | null;
  size?: number;
  className?: string;
};

export function FolderGlyph({
  icon,
  color,
  size = 22,
  className = "",
}: FolderGlyphProps) {
  const iconSize = Math.round(size * 0.59);
  return (
    <span
      aria-hidden
      className={[
        "inline-grid shrink-0 place-items-center rounded-md",
        className,
      ].join(" ")}
      style={{
        width: size,
        height: size,
        background: color ?? "var(--accent-subtle)",
      }}
    >
      <LucideIcon
        name={icon ?? "folder"}
        size={iconSize}
        className="text-[color:var(--accent-fg)]"
        strokeWidth={2}
      />
    </span>
  );
}
