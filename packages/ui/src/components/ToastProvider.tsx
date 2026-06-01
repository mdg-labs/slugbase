import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "success" | "info" | "warning" | "danger";

export type ToastInput = {
  title: ReactNode;
  description?: ReactNode;
  kind?: ToastKind;
  durationMs?: number;
};

type ToastRecord = ToastInput & {
  id: string;
};

export type ToastContextValue = {
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 3200;

const kindClasses: Record<ToastKind, string> = {
  success: "bg-[color:var(--success-subtle)] text-success-text",
  info: "bg-[color:var(--accent-subtle)] text-accent-text",
  warning: "bg-[color:var(--warning-subtle)] text-warning-text",
  danger: "bg-[color:var(--danger-subtle)] text-danger-text",
};

export type ToastProviderProps = {
  children: ReactNode;
  dismissLabel: string;
};

function ToastViewport({
  items,
  onDismiss,
  dismissLabel,
}: {
  items: ToastRecord[];
  onDismiss: (id: string) => void;
  dismissLabel: string;
}) {
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timers = timersRef.current;
    for (const item of items) {
      if (timers.has(item.id)) continue;
      const duration = item.durationMs ?? DEFAULT_DURATION_MS;
      timers.set(
        item.id,
        setTimeout(() => {
          onDismiss(item.id);
          timers.delete(item.id);
        }, duration),
      );
    }
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, [items, onDismiss]);

  if (items.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-sp-7 right-sp-7 z-[120] flex max-w-[min(100vw-2rem,360px)] flex-col gap-sp-4"
      aria-live="polite"
      aria-relevant="additions"
      data-testid="toast-viewport"
    >
      {items.map((item) => {
        const kind = item.kind ?? "success";
        return (
          <div
            key={item.id}
            className="pointer-events-auto flex animate-toast-in items-start gap-sp-4 rounded-lg border border-[color:var(--border-strong)] bg-overlay p-sp-5 shadow-overlay motion-reduce:animate-none"
            data-testid={`toast-${item.id}`}
            role="status"
          >
            <span
              aria-hidden="true"
              className={`grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md ${kindClasses[kind]}`}
            >
              <span className="h-2 w-2 rounded-full bg-current" />
            </span>
            <div className="min-w-0 flex-1 text-left">
              <p
                className="m-0 text-fg"
                style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
              >
                {item.title}
              </p>
              {item.description ? (
                <p
                  className="mt-sp-1 m-0 text-fg-subtle"
                  style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                >
                  {item.description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              className="shrink-0 rounded-sm px-sp-2 py-sp-1 text-fg-subtle transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => {
                onDismiss(item.id);
              }}
              aria-label={dismissLabel}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function ToastProvider({ children, dismissLabel }: ToastProviderProps) {
  const [items, setItems] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((input: ToastInput) => {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
    setItems((current) => [...current, { ...input, id }]);
    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} dismissLabel={dismissLabel} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}
