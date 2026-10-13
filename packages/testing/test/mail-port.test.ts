import type { MailPort } from "@slugbase/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { InMemoryMail } from "../src/index.ts";

// Doc 08 section 3.1: the in-memory ports are checked against the ports they stand in for here, in
// @slugbase/testing, because @slugbase/testing-ports imports no workspace package.
describe("InMemoryMail against MailPort", () => {
  it("is assignable to the port, so a change to the port that the fake does not follow fails the typecheck", () => {
    expectTypeOf<InMemoryMail>().toExtend<MailPort>();
    const port: MailPort = new InMemoryMail();
    expect(port.available).toBe(true);
  });

  it("captures a message sent through the port type", async () => {
    const mail = new InMemoryMail();
    const port: MailPort = mail;
    await port.send({ template: "verify", to: "a@example.test", locale: "en", data: { link: "x" } });
    expect(mail.sent).toHaveLength(1);
  });
});
