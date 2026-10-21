import type { ComponentTypes } from "@slugbase/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ApiProblemError, type ApiClient } from "../api/client.ts";

export type InstanceSettings = ComponentTypes["schemas"]["InstanceSettings"];
export type InstanceSettingsChanges = ComponentTypes["schemas"]["UpdateInstanceSettingsRequest"];

export const ADMIN_SETTINGS_QUERY_KEY = ["admin", "settings"] as const;

/** The settings as stored; a setting that was never set is null. Only an instance admin with a second factor may ask. */
export function instanceSettingsQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ADMIN_SETTINGS_QUERY_KEY,
    queryFn: async ({ signal }): Promise<InstanceSettings> => {
      const { data, error } = await api.GET("/api/v1/instance/settings", { signal });
      if (data === undefined) {
        throw new Error("The instance settings request did not answer with a document", { cause: error });
      }
      return data;
    },
  });
}

/** Why a change was refused, as far as the admin is told. */
export type SettingsRefusal =
  | { readonly kind: "forbidden" | "mailUnavailable" }
  | { readonly kind: "invalid"; readonly fields: readonly string[] }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined };

export type SettingsSave = { readonly status: "saved"; readonly settings: InstanceSettings } | { readonly status: "refused"; readonly refusal: SettingsRefusal };

/**
 * Changes the settings (doc 04 section 10.10): a field the change leaves out keeps its value and null clears one. A refusal the page
 * explains is an answer; any other failure throws.
 */
export async function updateInstanceSettings(api: ApiClient, changes: InstanceSettingsChanges): Promise<SettingsSave> {
  try {
    const { data, error } = await api.PATCH("/api/v1/instance/settings", { body: changes });
    if (data === undefined) {
      throw new Error("The settings update did not answer with a document", { cause: error });
    }
    return { status: "saved", settings: data };
  } catch (caught) {
    if (caught instanceof ApiProblemError) {
      if (caught.status === 403) {
        return { status: "refused", refusal: { kind: "forbidden" } };
      }
      if (caught.status === 422) {
        return { status: "refused", refusal: { kind: "invalid", fields: caught.errors.map((field) => field.path) } };
      }
      if (caught.status === 429) {
        return { status: "refused", refusal: { kind: "rateLimited", seconds: caught.retryAfterSeconds } };
      }
    }
    throw caught;
  }
}

export type TestMail = { readonly status: "queued" } | { readonly status: "refused"; readonly refusal: SettingsRefusal };

/** Queues a test email to the calling admin's address. A refusal the page explains, such as no mail adapter, is an answer; any other failure throws. */
export async function sendTestMail(api: ApiClient): Promise<TestMail> {
  try {
    const { response, error } = await api.POST("/api/v1/instance/mail/test");
    if (!response.ok) {
      throw new Error("The test email request did not answer with a success", { cause: error });
    }
    return { status: "queued" };
  } catch (caught) {
    if (caught instanceof ApiProblemError) {
      if (caught.status === 403) {
        return { status: "refused", refusal: { kind: "forbidden" } };
      }
      if (caught.status === 429) {
        return { status: "refused", refusal: { kind: "rateLimited", seconds: caught.retryAfterSeconds } };
      }
      if (caught.status === 503 && caught.code === "mail_unavailable") {
        return { status: "refused", refusal: { kind: "mailUnavailable" } };
      }
    }
    throw caught;
  }
}
