import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { BrowserSetupSection } from "./browser-setup-section.tsx";
import { ChoicesSection } from "./choices-section.tsx";
import { SlugsSection } from "./slugs-section.tsx";

// The shell's main area has no padding of its own: each page keeps its content off the edges, as the settings and admin layouts do.
const PAGE_FRAME = "flex w-full min-w-0 flex-col gap-4 p-4 md:p-6";

/**
 * `/forwarding` (doc 03 section 8, Q20): the home of the slug feature. It shows how to set up the browser's address bar, lists the
 * member's slugs with the switch that turns forwarding on or off for each, and the choices `/go` remembers for them.
 */
export function ForwardingPage(): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={PAGE_FRAME}>
      <h1 className="font-semibold text-2xl leading-none">{t("forwarding.page.title")}</h1>
      <BrowserSetupSection />
      <SlugsSection />
      <ChoicesSection />
    </div>
  );
}
