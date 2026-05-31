export interface MfaBackupCodeRecord {
  id: string;
  userId: string;
  codeHash: string;
  usedAt: Date | null;
  createdAt: Date;
}

export interface MfaEnrolStartResult {
  otpAuthUri: string;
  textSecret: string;
  qrDataUri: string;
}

export interface MfaEnrolConfirmResult {
  backupCodes: string[];
}
