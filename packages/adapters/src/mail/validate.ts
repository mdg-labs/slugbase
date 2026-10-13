// A CR or LF in a value that reaches a header line ends the line and starts a
// new one, so the recipient, the subject and every header are refused with one.
const LINE_BREAK = /[\r\n]/;

// One plain mailbox: a local part and a domain, with nothing that makes it a list,
// a display name or a group.
const SINGLE_ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+$/;

const HEADER_NAME = /^[A-Za-z0-9-]+$/;

// The headers the adapter sets itself or that decide who receives the message.
const RESERVED_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "sender",
  "return-path",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
]);

export function isSingleRecipient(address: string): boolean {
  return !LINE_BREAK.test(address) && SINGLE_ADDRESS.test(address);
}

export function isSafeSubject(subject: string): boolean {
  return !LINE_BREAK.test(subject);
}

export function areSafeHeaders(headers: Readonly<Record<string, string>>): boolean {
  return Object.entries(headers).every(
    ([name, value]) => HEADER_NAME.test(name) && !RESERVED_HEADERS.has(name.toLowerCase()) && !LINE_BREAK.test(value),
  );
}
