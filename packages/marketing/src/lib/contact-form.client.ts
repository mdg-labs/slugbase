import { submitContactForm, type ContactSubmitPayload } from "./contact-form.js";
import type { ContactTopic } from "./contact-config.js";

export interface ContactFormClientConfig {
  contactEndpoint: string;
  turnstileSiteKey: string;
  nameMaxLength: number;
  messageMaxLength: number;
  messages: {
    errorGeneric: string;
    errorValidation: string;
    errorRateLimit: string;
    errorUnavailable: string;
    errorChallenge: string;
  };
}

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
    },
  ) => string;
  reset: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    onTurnstileLoad?: () => void;
  }
}

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad";

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    window.onTurnstileLoad = () => {
      resolve();
    };
    const existing = document.querySelector(`script[src^="https://challenges.cloudflare.com/turnstile/"]`);
    if (existing) {
      const poll = window.setInterval(() => {
        if (window.turnstile) {
          window.clearInterval(poll);
          resolve();
        }
      }, 50);
      return;
    }
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      reject(new Error("Turnstile script failed to load"));
    };
    document.head.appendChild(script);
  });
}

function mapSubmitError(status: number, messages: ContactFormClientConfig["messages"]): string {
  if (status === 400) {
    return messages.errorValidation;
  }
  if (status === 429) {
    return messages.errorRateLimit;
  }
  if (status === 503) {
    return messages.errorUnavailable;
  }
  return messages.errorGeneric;
}

export function initContactForm(config: ContactFormClientConfig): void {
  const root = document.getElementById("contact-form-root");
  const form = document.getElementById("contact-form") as HTMLFormElement | null;
  const successPanel = document.getElementById("contact-success");
  const errorBanner = document.getElementById("contact-error");
  const submitButton = document.getElementById("contact-submit") as HTMLButtonElement | null;
  const turnstileMount = document.getElementById("contact-turnstile");
  const successEmail = document.getElementById("contact-success-email");
  const anotherButton = document.getElementById("contact-send-another");

  if (!root || !form || !successPanel || !errorBanner || !submitButton) {
    return;
  }

  const formEl = form;
  const successPanelEl = successPanel;
  const errorBannerEl = errorBanner;
  const submitButtonEl = submitButton;

  let challengeToken = config.turnstileSiteKey.length === 0 ? "local-dev" : "";
  let turnstileWidgetId: string | undefined;
  let turnstileReady = config.turnstileSiteKey.length === 0;

  function setError(message: string | null): void {
    if (!message) {
      errorBannerEl.hidden = true;
      errorBannerEl.textContent = "";
      return;
    }
    errorBannerEl.hidden = false;
    errorBannerEl.textContent = message;
  }

  function updateSubmitEnabled(): void {
    const message = (formEl.querySelector<HTMLTextAreaElement>('[name="message"]')?.value ?? "").trim();
    submitButtonEl.disabled = !message || !turnstileReady || !config.contactEndpoint;
  }

  function showSuccess(email: string): void {
    formEl.hidden = true;
    successPanelEl.hidden = false;
    if (successEmail) {
      successEmail.textContent = email;
    }
    setError(null);
  }

  function resetForm(): void {
    formEl.reset();
    formEl.hidden = false;
    successPanelEl.hidden = true;
    challengeToken = config.turnstileSiteKey.length === 0 ? "local-dev" : "";
    turnstileReady = config.turnstileSiteKey.length === 0;
    if (turnstileWidgetId && window.turnstile) {
      window.turnstile.reset(turnstileWidgetId);
    }
    updateSubmitEnabled();
  }

  async function mountTurnstile(): Promise<void> {
    if (!turnstileMount || config.turnstileSiteKey.length === 0) {
      return;
    }

    await loadTurnstileScript();
    if (!window.turnstile) {
      setError(config.messages.errorChallenge);
      return;
    }

    turnstileWidgetId = window.turnstile.render(turnstileMount, {
      sitekey: config.turnstileSiteKey,
      callback: (token: string) => {
        challengeToken = token;
        turnstileReady = true;
        setError(null);
        updateSubmitEnabled();
      },
      "error-callback": () => {
        challengeToken = "";
        turnstileReady = false;
        setError(config.messages.errorChallenge);
        updateSubmitEnabled();
      },
      "expired-callback": () => {
        challengeToken = "";
        turnstileReady = false;
        updateSubmitEnabled();
      },
    });
  }

  formEl.addEventListener("input", () => {
    updateSubmitEnabled();
  });

  formEl.addEventListener("submit", (event) => {
    void handleSubmit(event);
  });

  async function handleSubmit(event: Event): Promise<void> {
    event.preventDefault();
    setError(null);

    if (!config.contactEndpoint) {
      setError(config.messages.errorUnavailable);
      return;
    }

    if (!challengeToken) {
      setError(config.messages.errorChallenge);
      return;
    }

    const name = (formEl.querySelector<HTMLInputElement>('[name="name"]')?.value ?? "").trim();
    const email = (formEl.querySelector<HTMLInputElement>('[name="email"]')?.value ?? "").trim();
    const topic = (formEl.querySelector<HTMLSelectElement>('[name="topic"]')?.value ??
      "general") as ContactTopic;
    const message = (formEl.querySelector<HTMLTextAreaElement>('[name="message"]')?.value ?? "").trim();

    if (!name || !email || !message) {
      setError(config.messages.errorValidation);
      return;
    }

    const payload: ContactSubmitPayload = {
      name: name.slice(0, config.nameMaxLength),
      email,
      topic,
      message: message.slice(0, config.messageMaxLength),
      challengeToken,
    };

    submitButtonEl.disabled = true;

    const result = await submitContactForm(config.contactEndpoint, payload);

    if (!result.ok) {
      setError(mapSubmitError(result.status, config.messages));
      submitButtonEl.disabled = false;
      updateSubmitEnabled();
      return;
    }

    showSuccess(email);
    submitButtonEl.disabled = false;
  }

  anotherButton?.addEventListener("click", () => {
    resetForm();
  });

  void mountTurnstile().finally(() => {
    updateSubmitEnabled();
  });
}
