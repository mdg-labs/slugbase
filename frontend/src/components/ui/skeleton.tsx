import type { HTMLAttributes } from "react"
import { cn } from "@/lib/utils"

/** One-time keyframes for mockup shimmer (Phase 2.8) — avoids editing global CSS. */
function ensureSkeletonKeyframes() {
  if (typeof document === "undefined") return
  const id = "slugbase-skeleton-shimmer-keyframes"
  if (document.getElementById(id)) return
  const el = document.createElement("style")
  el.id = id
  el.textContent = `
@keyframes slugbase-skeleton-shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
`
  document.head.appendChild(el)
}

ensureSkeletonKeyframes()

/**
 * Mockup skeleton: `--bg-3` base, `--bg-4` highlight sweep, 1.5s linear infinite.
 * Radius inherits from `className` (e.g. `rounded-md`, `rounded-lg`).
 */
function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative isolate overflow-hidden bg-[var(--bg-3)]",
        className
      )}
      {...props}
    >
      <div
        className="pointer-events-none absolute inset-0 -translate-x-full animate-[slugbase-skeleton-shimmer_1.5s_linear_infinite]"
        style={{
          background:
            "linear-gradient(90deg, transparent, color-mix(in srgb, var(--bg-4) 85%, transparent), transparent)",
        }}
        aria-hidden
      />
    </div>
  )
}

export { Skeleton }
