import { AuthCard, type AuthCardProps } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { Slot, useSlotFilled } from "../extensions/index.ts";

/**
 * The authentication card every auth page sits in. Its footer carries the slot `auth.footer`
 * (doc 03 section 1); with no extension filling it the card has no footer at all.
 */
export function AuthPage(props: Omit<AuthCardProps, "footer">): ReactElement {
  const hasFooter = useSlotFilled("auth.footer");
  return <AuthCard {...props} footer={hasFooter ? <Slot name="auth.footer" /> : undefined} />;
}
