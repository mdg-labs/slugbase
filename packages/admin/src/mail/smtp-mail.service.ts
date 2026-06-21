import nodemailer, { type Transporter } from "nodemailer";

import type { AdminEnv } from "../config/env.schema.js";

export interface AdminMailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface AdminMailSender {
  send(message: AdminMailMessage): Promise<void>;
}

export class AdminSmtpMailService implements AdminMailSender {
  private readonly transport: Transporter;
  private readonly fromAddress: string;

  constructor(config: AdminEnv) {
    this.fromAddress = config.SMTP_FROM;
    this.transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
      },
    });
  }

  async send(message: AdminMailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.fromAddress,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
