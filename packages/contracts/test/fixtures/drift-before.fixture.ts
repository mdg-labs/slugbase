import { z } from "zod";
import { defineOperation, jsonResponse, problemResponse } from "../../src/operations/define.ts";

const NoteSchema = z.strictObject({ text: z.string() }).meta({ id: "Note" });

export const getNote = defineOperation({
  method: "get",
  path: "/api/v1/note",
  operationId: "getNote",
  tag: "notes",
  summary: "The note",
  auth: "anonymous",
  rate: "public",
  responses: {
    200: jsonResponse("The note", NoteSchema),
    400: problemResponse("The request was malformed"),
  },
});

export const operations: readonly unknown[] = [getNote];
