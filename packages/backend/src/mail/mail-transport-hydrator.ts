/**
 * Hydrates {@link SmtpMailService} from persisted instance settings when env
 * credentials are absent (spec §11.1, §15).
 */
export interface MailTransportHydrator {
  /** Loads DB-backed SMTP settings into the transport when needed. */
  hydrateIfNeeded(): Promise<boolean>;
}
