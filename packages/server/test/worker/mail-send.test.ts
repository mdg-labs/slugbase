import { describe, expect, it } from "vitest";
import { MAIL_SEND_JOB, mailSendJob, queueMailSend } from "../../src/worker/jobs/mail-send.ts";

const ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";
const JOB_ID = "0192f3a0-eeee-7000-8000-000000000001";
const SIGNED_IN_AT = "2026-10-17T17:30:00.000Z";

describe("the mail.send job", () => {
  it("is named mail.send and keeps the default retry policy, which retries with backoff", () => {
    expect(mailSendJob.name).toBe("mail.send");
    expect(MAIL_SEND_JOB).toBe("mail.send");
    expect(mailSendJob.retry).toMatchObject({ limit: 3, backoff: true });
  });

  it("queues the template and the account's identifier only", () => {
    expect(queueMailSend(JOB_ID, "passwordChanged", ACCOUNT)).toEqual({
      id: JOB_ID,
      queue: "mail.send",
      data: { template: "passwordChanged", accountId: ACCOUNT },
    });
  });

  it("queues the password-reset template with the account's identifier only: the token is made when the job runs", () => {
    expect(queueMailSend(JOB_ID, "passwordReset", ACCOUNT)).toEqual({
      id: JOB_ID,
      queue: "mail.send",
      data: { template: "passwordReset", accountId: ACCOUNT },
    });
    expect(() => mailSendJob.parse({ template: "passwordReset", accountId: ACCOUNT, token: "x".repeat(43) })).toThrow();
  });

  it("queues the emailChange template with the account's identifier only: the address it concerns is read and the tokens made when the job runs", () => {
    expect(queueMailSend(JOB_ID, "emailChange", ACCOUNT)).toEqual({ id: JOB_ID, queue: "mail.send", data: { template: "emailChange", accountId: ACCOUNT } });
    expect(() => mailSendJob.parse({ template: "emailChange", accountId: ACCOUNT, token: "x".repeat(43) })).toThrow();
    expect(() => mailSendJob.parse({ template: "emailChange", accountId: ACCOUNT, email: "new@example.test" })).toThrow();
  });

  it("has no job of its own for the email-change notice: it goes out in the job of the confirmation", () => {
    expect(() => mailSendJob.parse({ template: "emailChangeNotice", accountId: ACCOUNT })).toThrow();
  });

  it("queues the time, browser family and network prefix a new sign-in email shows beside the template and the account, and nothing else", () => {
    expect(queueMailSend(JOB_ID, "newSignIn", ACCOUNT, { signedInAt: SIGNED_IN_AT, browser: "Chrome", network: "203.0.0.0/16" })).toEqual({
      id: JOB_ID,
      queue: "mail.send",
      data: { template: "newSignIn", accountId: ACCOUNT, signedInAt: SIGNED_IN_AT, browser: "Chrome", network: "203.0.0.0/16" },
    });
    expect(queueMailSend(JOB_ID, "newSignIn", ACCOUNT, { signedInAt: SIGNED_IN_AT }).data).toEqual({ template: "newSignIn", accountId: ACCOUNT, signedInAt: SIGNED_IN_AT });
    expect(() => queueMailSend(JOB_ID, "newSignIn", ACCOUNT, { signedInAt: "yesterday" })).toThrow();
  });

  it("refuses a payload that carries an address, a body or a template the core does not name", () => {
    expect(() => mailSendJob.parse({ template: "passwordChanged", accountId: ACCOUNT, to: "a@example.test" })).toThrow();
    expect(() => mailSendJob.parse({ template: "passwordChanged", accountId: ACCOUNT, body: "text" })).toThrow();
    expect(() => mailSendJob.parse({ template: "somethingElse", accountId: ACCOUNT })).toThrow();
    expect(() => mailSendJob.parse({ template: "passwordChanged", accountId: "not-a-uuid" })).toThrow();
    expect(() => mailSendJob.parse({ template: "newSignIn", accountId: ACCOUNT, signedInAt: SIGNED_IN_AT, ip: "203.0.113.57" })).toThrow();
    expect(() => mailSendJob.parse({ template: "newSignIn", accountId: ACCOUNT, userAgent: "Firefox" })).toThrow();
  });
});
