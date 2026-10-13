import { describe, expect, it } from "vitest";
import { InMemoryMail } from "../src/index.ts";

describe("InMemoryMail", () => {
  it("is available and captures messages in the order they were sent", async () => {
    const mail = new InMemoryMail();
    expect(mail.available).toBe(true);
    await mail.send({ template: "verify", to: "a@example.test", locale: "en", data: { link: "x" } });
    await mail.send({ template: "reset", to: "b@example.test", locale: "de", data: {} });
    expect(mail.sent.map((message) => message.to)).toEqual(["a@example.test", "b@example.test"]);
    expect(mail.sent[0]).toEqual({ template: "verify", to: "a@example.test", locale: "en", data: { link: "x" } });
  });

  it("keeps a copy, so changing the sent object or the list does not change what was captured", async () => {
    const mail = new InMemoryMail();
    const data: Record<string, string> = { link: "x" };
    await mail.send({ template: "verify", to: "a@example.test", locale: "en", data });
    data["link"] = "changed";
    (mail.sent as unknown[]).length = 0;
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.data).toEqual({ link: "x" });
  });

  it("forgets what was captured on clear", async () => {
    const mail = new InMemoryMail();
    await mail.send({ template: "verify", to: "a@example.test", locale: "en", data: {} });
    mail.clear();
    expect(mail.sent).toEqual([]);
  });

  it.each(["a@example.test, b@example.test", "a@example.test\r\nBcc: x@example.test", "a@example.test\n", "Name <a@example.test>", "no-at-sign", ""])(
    "rejects the recipient %j without capturing the message",
    async (to) => {
      const mail = new InMemoryMail();
      await expect(mail.send({ template: "verify", to, locale: "en", data: {} })).rejects.toThrow("invalid_message");
      expect(mail.sent).toEqual([]);
    },
  );
});
