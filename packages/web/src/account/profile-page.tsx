import { Button, Input } from "@slugbase/ui";
import { AccountAvatar, Banner, FormField, Loading, SelectField, SettingsSection, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError } from "../api/client.ts";
import type { Locale } from "../i18n/locales.ts";
import { supportedLocale } from "../i18n/resolve-language.ts";
import { ME_QUERY_KEY, meQuery, withAccount, type Account, type Me, type UpdateAccountRequest } from "./me.ts";

const NAME_MAX_LENGTH = 100;

type FieldName = "displayName" | "locale";
type NameError = "required" | "tooLong" | "invalid";

/** The fields the server refused, from the field errors of its problem document. */
function refusedFields(error: unknown): ReadonlySet<FieldName> {
  const fields = new Set<FieldName>();
  if (error instanceof ApiProblemError && error.status === 422) {
    for (const { path } of error.errors) {
      if (path === "displayName" || path === "locale") {
        fields.add(path);
      }
    }
  }
  return fields;
}

function ProfileForm({ account }: { account: Account }): ReactElement {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState(account.displayName);
  const [locale, setLocale] = useState<Locale>(account.locale);
  const [clientError, setClientError] = useState<NameError | undefined>(undefined);

  const save = useMutation({
    mutationFn: async (changes: UpdateAccountRequest): Promise<Account> => {
      const { data, error } = await router.options.context.api.PATCH("/api/v1/me", { body: changes });
      if (data === undefined) {
        throw new Error("The profile update did not answer with an account", { cause: error });
      }
      return data;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<Me>(ME_QUERY_KEY, (current) => withAccount(current, saved));
      // The interface switches to the saved language as this runs, so the message is worded in it.
      feedbackToast.success(i18n.t("settings.account.saved", { lng: saved.locale }));
    },
  });

  const trimmed = name.trim();
  const changes: UpdateAccountRequest = {
    ...(trimmed === account.displayName ? {} : { displayName: trimmed }),
    ...(locale === account.locale ? {} : { locale }),
  };
  const dirty = Object.keys(changes).length > 0;
  const refused = refusedFields(save.error);
  const nameError: NameError | undefined = clientError ?? (refused.has("displayName") ? "invalid" : undefined);
  const languageError = refused.has("locale") ? t("settings.account.language.error.invalid") : undefined;
  const languageOptions = [
    { value: "en", label: t("settings.account.language.option.en") },
    { value: "de", label: t("settings.account.language.option.de") },
  ];

  function nameMessage(error: NameError | undefined): string | undefined {
    switch (error) {
      case undefined:
        return undefined;
      case "required":
        return t("settings.account.name.error.required");
      case "tooLong":
        return t("settings.account.name.error.tooLong");
      case "invalid":
        return t("settings.account.name.error.invalid");
    }
  }

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (save.isPending || !dirty) {
      return;
    }
    if (trimmed === "") {
      setClientError("required");
      return;
    }
    if (Array.from(trimmed).length > NAME_MAX_LENGTH) {
      setClientError("tooLong");
      return;
    }
    setClientError(undefined);
    save.mutate(changes);
  }

  return (
    <form noValidate onSubmit={submit}>
      <SettingsSection
        description={t("settings.account.section.description")}
        footer={
          <Button disabled={!dirty} loading={save.isPending} type="submit">
            {t("settings.account.save")}
          </Button>
        }
        title={t("settings.account.section.title")}
      >
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-4">
            <AccountAvatar name={trimmed === "" ? account.displayName : trimmed} seed={account.id} size="lg" />
            <p className="text-muted-foreground text-sm">{t("settings.account.avatar.caption")}</p>
          </div>
          <FormField error={nameMessage(nameError)} label={t("settings.account.name.label")} name="displayName">
            <Input
              autoComplete="name"
              disabled={save.isPending}
              onChange={(event) => {
                setName(event.target.value);
                setClientError(undefined);
                save.reset();
              }}
              value={name}
            />
          </FormField>
          <FormField description={t("settings.account.email.description")} label={t("settings.account.email.label")} name="email">
            <Input readOnly type="email" value={account.email} />
          </FormField>
          <SelectField
            description={t("settings.account.language.description")}
            disabled={save.isPending}
            error={languageError}
            label={t("settings.account.language.label")}
            name="locale"
            onValueChange={(next) => {
              setLocale(supportedLocale(next) ?? account.locale);
              save.reset();
            }}
            options={languageOptions}
            value={locale}
          />
        </div>
      </SettingsSection>
    </form>
  );
}

/** `/settings/account` (doc 03 section 11.1): the profile of the signed-in account. */
export function AccountProfilePage(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const me = useQuery(meQuery(router.options.context.api));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-semibold text-xl">{t("settings.account.title")}</h1>
      {me.data === undefined ? null : <ProfileForm account={me.data.account} key={me.data.account.id} />}
      {me.isPending ? <Loading label={t("shell.loading")} /> : null}
      {me.isError ? (
        <Banner
          action={
            <Button
              onClick={() => {
                void me.refetch();
              }}
              size="sm"
              variant="outline"
            >
              {t("settings.account.loadFailed.retry")}
            </Button>
          }
          description={t("settings.account.loadFailed.description")}
          title={t("settings.account.loadFailed.title")}
          variant="error"
        />
      ) : null}
    </div>
  );
}
