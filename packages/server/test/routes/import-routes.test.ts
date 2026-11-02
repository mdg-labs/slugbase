import { describe, expect, it } from "vitest";
import { loadCommittedDocument } from "../../src/routes/committed-document.ts";
import { importRoutes } from "../../src/routes/import/index.ts";
import { checkRegistrations } from "../../src/routes/register.ts";

// The routes of the import tag as they are registered (doc 04 sections 1.1, 5.1 and 10.9): both operations are bound to the committed document with the policy it declares, and the upload is the one
// route that accepts multipart (`acceptsMultipart`), which makes the cross-site stage admit its media type and the validation stage leave its body alone.

const routes = importRoutes({ entitlements: { limit: () => Promise.resolve("unlimited") } });

describe("importRoutes", () => {
  it("binds the JSON import and the Netscape import, each as the committed document declares it", () => {
    expect(routes.map((binding) => binding.operation.operationId)).toEqual(["importJson", "importNetscape"]);
    expect(checkRegistrations(routes, loadCommittedDocument())).toBeUndefined();
  });

  it("accepts multipart on the Netscape import alone", () => {
    expect(routes.filter((binding) => binding.acceptsMultipart === true).map((binding) => binding.operation.operationId)).toEqual(["importNetscape"]);
  });

  it("declares the upload as the body of the Netscape import, no token scope and the bulk bucket", () => {
    const netscape = routes.find((binding) => binding.operation.operationId === "importNetscape")?.operation;

    expect(netscape?.request).toMatchObject({ upload: { field: "file" } });
    expect(netscape).toMatchObject({ auth: "member", rate: "bulk", idempotency: true });
    expect(netscape).not.toHaveProperty("scope");
  });
});
