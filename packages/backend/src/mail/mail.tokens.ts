export const MAIL = Symbol("MAIL");

/** Injection token for {@link MailTransportHydrator} — breaks ESM circular import with MailRuntimeService. */
export const MAIL_TRANSPORT_HYDRATOR = Symbol("MAIL_TRANSPORT_HYDRATOR");
