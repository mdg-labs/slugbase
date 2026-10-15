import { describe, expect, it } from "vitest";
import { MAIL_SEND_JOB, mailSendJob, queueMailSend } from "../../src/worker/jobs/mail-send.ts";

const ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";
const JOB_ID = "0192f3a0-eeee-7000-8000-000000000001";

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

  it("refuses a payload that carries an address, a body or a template the core does not name", () => {
    expect(() => mailSendJob.parse({ template: "passwordChanged", accountId: ACCOUNT, to: "a@example.test" })).toThrow();
    expect(() => mailSendJob.parse({ template: "passwordChanged", accountId: ACCOUNT, body: "text" })).toThrow();
    expect(() => mailSendJob.parse({ template: "somethingElse", accountId: ACCOUNT })).toThrow();
    expect(() => mailSendJob.parse({ template: "passwordChanged", accountId: "not-a-uuid" })).toThrow();
  });
});
