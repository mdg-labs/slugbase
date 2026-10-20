import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { invitationLink } from "./mailpit.ts";

const ORIGIN = "https://127.0.0.1:23456";

void describe("the invitation link of a mail", () => {
  void it("is the link under the origin of the app, wherever it stands in the text", () => {
    const text = `Ada invited you.\n\nAccept the invitation:\n${ORIGIN}/invite/abc_DEF-123\n\nIf you did not expect it, ignore this.`;
    assert.equal(invitationLink(text, ORIGIN), `${ORIGIN}/invite/abc_DEF-123`);
    assert.equal(invitationLink(text, `${ORIGIN}/`), `${ORIGIN}/invite/abc_DEF-123`);
  });

  void it("takes a link that the text repeats as one", () => {
    const link = `${ORIGIN}/invite/token`;
    assert.equal(invitationLink(`${link}\nor open ${link}`, ORIGIN), link);
  });

  void it("refuses a link to another origin, a prefix without a token and two different links", () => {
    assert.throws(() => invitationLink("https://example.test/invite/token", ORIGIN), /not one/);
    assert.throws(() => invitationLink(`${ORIGIN}/invite/`, ORIGIN), /not one/);
    assert.throws(() => invitationLink(`${ORIGIN}/invite/a ${ORIGIN}/invite/b`, ORIGIN), /not one/);
    assert.throws(() => invitationLink(`${ORIGIN}.evil.test/invite/token`, ORIGIN), /not one/);
  });
});
