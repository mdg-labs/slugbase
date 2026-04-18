import * as React from "react"
import { Toaster as Sonner } from "sonner"
import { AlertTriangle, Check, Info, X } from "lucide-react"

import { cn } from "@/lib/utils"

type ToasterProps = React.ComponentProps<typeof Sonner>

function useTheme() {
  const [theme, setTheme] = React.useState<"light" | "dark" | "system">("system")
  React.useEffect(() => {
    const el = document.documentElement
    const check = () =>
      setTheme(el.classList.contains("dark") ? "dark" : "light")
    check()
    const observer = new MutationObserver(check)
    observer.observe(el, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [])
  return { theme }
}

/** 22×22 icon disc — mockup `.toast .ti` (`gaps_styles.css` L610–615). */
function ToastIconWrap({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full [&_svg]:size-[13px]",
        className
      )}
    >
      {children}
    </span>
  )
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position="bottom-right"
      className="toaster group"
      offset={16}
      gap={8}
      toastOptions={{
        classNames: {
          toast: cn(
            "!flex !items-start !gap-2.5",
            "w-[340px] max-w-[calc(100vw-32px)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-1)] p-3 shadow-[var(--shadow)]",
            "text-[12.5px] text-[var(--fg-0)]"
          ),
          title: "font-medium text-[var(--fg-0)]",
          description: "mt-px text-[11.5px] text-[var(--fg-2)]",
          actionButton:
            "!h-auto shrink-0 rounded-md border-0 bg-transparent px-2 py-1 text-[12.5px] font-medium text-[var(--fg-1)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg-0)]",
          cancelButton:
            "!h-auto rounded-md border-0 bg-transparent px-2 py-1 text-[12.5px] text-[var(--fg-2)] hover:bg-[var(--bg-hover)]",
          closeButton:
            "!border-0 !bg-transparent !text-[var(--fg-3)] hover:!bg-[var(--bg-3)] hover:!text-[var(--fg-0)]",
          success:
            "!border-[rgba(74,222,128,0.3)]",
          error:
            "!border-[rgba(248,113,113,0.3)]",
          warning:
            "!border-[rgba(251,191,36,0.3)]",
          info:
            "!border-[rgba(96,165,250,0.3)]",
        },
      }}
      icons={{
        success: (
          <ToastIconWrap className="bg-[rgba(74,222,128,0.12)] text-[var(--success)]">
            <Check strokeWidth={1.75} aria-hidden />
          </ToastIconWrap>
        ),
        info: (
          <ToastIconWrap className="bg-[rgba(96,165,250,0.12)] text-[var(--info)]">
            <Info strokeWidth={1.75} aria-hidden />
          </ToastIconWrap>
        ),
        warning: (
          <ToastIconWrap className="bg-[rgba(251,191,36,0.12)] text-[var(--warn)]">
            <AlertTriangle strokeWidth={1.75} aria-hidden />
          </ToastIconWrap>
        ),
        error: (
          <ToastIconWrap className="bg-[rgba(248,113,113,0.12)] text-[var(--danger)]">
            <X strokeWidth={1.75} aria-hidden />
          </ToastIconWrap>
        ),
      }}
      {...props}
    />
  )
}

export { Toaster }
