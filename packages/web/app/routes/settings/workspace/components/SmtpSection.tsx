import { Input, Label } from "@slugbase/ui";
import { useEffect, useState } from "react";

import type { MailSettingsData } from "../workspace.types.js";
import { MailTestRequestError } from "../workspace-api.js";
import { SaveBar, SettingsSection } from "../../account/components/SettingsSection.js";

interface SmtpSectionProps {
  initial: MailSettingsData;
  onSave: (payload: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password?: string;
    fromAddress: string;
    fromName: string;
  }) => Promise<void>;
  onSendTest: (email: string) => Promise<void>;
  t: (key: string) => string;
}

const defaultMail: MailSettingsData = {
  host: "",
  port: 587,
  secure: false,
  username: "",
  hasPassword: false,
  fromAddress: "",
  fromName: "SlugBase",
};

export function SmtpSection({ initial, onSave, onSendTest, t }: SmtpSectionProps) {
  const [form, setForm] = useState(initial);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testFailureKey, setTestFailureKey] = useState<
    | "settings.workspace.smtp.test_failure"
    | "settings.workspace.smtp.test_failure_not_configured"
    | "settings.workspace.smtp.test_failure_auth"
  >("settings.workspace.smtp.test_failure");

  useEffect(() => {
    setForm(initial);
    setPassword("");
    setTestState("idle");
  }, [initial]);

  const dirty =
    form.host !== initial.host ||
    form.port !== initial.port ||
    form.secure !== initial.secure ||
    form.username !== initial.username ||
    form.fromAddress !== initial.fromAddress ||
    form.fromName !== initial.fromName ||
    password.length > 0;

  const handleSave = async (): Promise<void> => {
    setBusy(true);
    try {
      await onSave({
        host: form.host,
        port: form.port,
        secure: form.secure,
        username: form.username,
        fromAddress: form.fromAddress,
        fromName: form.fromName,
        ...(password.length > 0 ? { password } : {}),
      });
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async (): Promise<void> => {
    setTestState("testing");
    try {
      await onSendTest(testEmail.trim());
      setTestState("ok");
    } catch (error) {
      if (error instanceof MailTestRequestError) {
        if (error.status === 503) {
          setTestFailureKey("settings.workspace.smtp.test_failure_not_configured");
        } else if (error.status === 400) {
          setTestFailureKey("settings.workspace.smtp.test_failure_auth");
        } else {
          setTestFailureKey("settings.workspace.smtp.test_failure");
        }
      } else {
        setTestFailureKey("settings.workspace.smtp.test_failure");
      }
      setTestState("fail");
    }
  };

  return (
    <SettingsSection
      titleKey="settings.workspace.smtp.title"
      descriptionKey="settings.workspace.smtp.description"
      t={t}
    >
      <div className="grid gap-sp-5 sm:grid-cols-2">
        <div className="flex flex-col gap-sp-2">
          <Label htmlFor="smtp-host">{t("settings.workspace.smtp.host_label")}</Label>
          <Input
            id="smtp-host"
            value={form.host}
            onChange={(event) => { setForm((prev) => ({ ...prev, host: event.target.value })); }}
          />
        </div>
        <div className="flex flex-col gap-sp-2">
          <Label htmlFor="smtp-port">{t("settings.workspace.smtp.port_label")}</Label>
          <Input
            id="smtp-port"
            type="number"
            value={String(form.port)}
            onChange={(event) => {
              const port = Number.parseInt(event.target.value, 10);
              setForm((prev) => ({
                ...prev,
                port: Number.isFinite(port) ? port : prev.port,
              }));
            }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-sp-2">
        <Label htmlFor="smtp-security">{t("settings.workspace.smtp.security_label")}</Label>
        <select
          id="smtp-security"
          className="w-full max-w-xs rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 text-fg"
          value={form.secure ? "tls" : "starttls"}
          onChange={(event) => {
            setForm((prev) => ({ ...prev, secure: event.target.value === "tls" }));
          }}
        >
          <option value="tls">{t("settings.workspace.smtp.security_tls")}</option>
          <option value="starttls">{t("settings.workspace.smtp.security_starttls")}</option>
          <option value="none">{t("settings.workspace.smtp.security_none")}</option>
        </select>
      </div>

      <div className="grid gap-sp-5 sm:grid-cols-2">
        <div className="flex flex-col gap-sp-2">
          <Label htmlFor="smtp-user">{t("settings.workspace.smtp.username_label")}</Label>
          <Input
            id="smtp-user"
            value={form.username}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, username: event.target.value }));
            }}
          />
        </div>
        <div className="flex flex-col gap-sp-2">
          <Label htmlFor="smtp-pass">{t("settings.workspace.smtp.password_label")}</Label>
          <Input
            id="smtp-pass"
            type="password"
            value={password}
            placeholder={
              form.hasPassword
                ? t("settings.workspace.smtp.password_placeholder_set")
                : t("settings.workspace.smtp.password_placeholder_empty")
            }
            onChange={(event) => { setPassword(event.target.value); }}
          />
        </div>
      </div>

      <div className="grid gap-sp-5 sm:grid-cols-2">
        <div className="flex flex-col gap-sp-2">
          <Label htmlFor="smtp-from">{t("settings.workspace.smtp.from_address_label")}</Label>
          <Input
            id="smtp-from"
            value={form.fromAddress}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, fromAddress: event.target.value }));
            }}
          />
        </div>
        <div className="flex flex-col gap-sp-2">
          <Label htmlFor="smtp-from-name">{t("settings.workspace.smtp.from_name_label")}</Label>
          <Input
            id="smtp-from-name"
            value={form.fromName}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, fromName: event.target.value }));
            }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-sp-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-sp-2">
          <Label htmlFor="smtp-test-email">{t("settings.workspace.smtp.test_email_label")}</Label>
          <Input
            id="smtp-test-email"
            type="email"
            value={testEmail}
            onChange={(event) => { setTestEmail(event.target.value); }}
          />
        </div>
        <button
          type="button"
          disabled={testState === "testing" || testEmail.trim().length === 0}
          onClick={() => { void handleTest(); }}
          className="rounded-md border border-[color:var(--border)] bg-raised px-sp-5 py-sp-3 font-medium text-fg transition-colors hover:bg-raised-2 disabled:opacity-50"
          style={{ fontSize: "var(--text-body)" }}
        >
          {testState === "testing"
            ? t("settings.workspace.smtp.test_sending")
            : t("settings.workspace.smtp.test_action")}
        </button>
      </div>
      {testState === "ok" ? (
        <p className="m-0 text-success-text" style={{ fontSize: "var(--text-small)" }}>
          {t("settings.workspace.smtp.test_success")}
        </p>
      ) : null}
      {testState === "fail" ? (
        <p className="m-0 text-danger-text" style={{ fontSize: "var(--text-small)" }}>
          {t(testFailureKey)}
        </p>
      ) : null}

      <SaveBar
        dirty={dirty}
        busy={busy}
        onSave={() => { void handleSave(); }}
        onDiscard={() => {
          setForm(initial);
          setPassword("");
        }}
        t={t}
      />
    </SettingsSection>
  );
}

export { defaultMail };
