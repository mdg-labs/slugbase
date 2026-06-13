export class FetchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchBlockedError";
  }
}

export class FetchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchTimeoutError";
  }
}

export class FetchSizeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchSizeLimitError";
  }
}

export class FetchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchRequestError";
  }
}
