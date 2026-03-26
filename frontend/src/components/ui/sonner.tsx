import * as React from "react"
import { Toaster as Sonner } from "sonner"

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

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-surface-high group-[.toaster]:text-foreground group-[.toaster]:border group-[.toaster]:border-ghost group-[.toaster]:shadow-glow",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary-gradient group-[.toast]:text-white",
          cancelButton:
            "group-[.toast]:bg-surface-low group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
