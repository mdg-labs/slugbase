import type { ReactNode } from "react";

export type FieldErrorProps = {
  id?: string;
  children: ReactNode;
};

export function FieldError({ id, children }: FieldErrorProps) {
  return (
    <p
      id={id}
      role="alert"
      className="text-danger-text"
      style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
    >
      {children}
    </p>
  );
}
