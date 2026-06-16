import type { LucideProps } from "lucide-react";
import * as LucideIcons from "lucide-react";
import { FolderIcon } from "lucide-react";

export function kebabToPascalCase(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function isLucideComponent(
  value: unknown,
): value is typeof FolderIcon {
  if (typeof value === "function") return true;
  return (
    typeof value === "object" &&
    value !== null &&
    "render" in value &&
    typeof (value as { render?: unknown }).render === "function"
  );
}

export function resolveLucideIcon(name: string | null | undefined) {
  if (!name) return FolderIcon;
  const pascal = kebabToPascalCase(name);
  const iconKey = `${pascal}Icon` as keyof typeof LucideIcons;
  const candidate = LucideIcons[iconKey];
  if (isLucideComponent(candidate)) {
    return candidate;
  }
  const legacyKey = pascal as keyof typeof LucideIcons;
  const legacy = LucideIcons[legacyKey];
  if (isLucideComponent(legacy)) {
    return legacy;
  }
  return FolderIcon;
}

export type LucideIconProps = LucideProps & {
  name: string | null | undefined;
};

export function LucideIcon({ name, ...props }: LucideIconProps) {
  const Icon = resolveLucideIcon(name);
  return <Icon {...props} />;
}
