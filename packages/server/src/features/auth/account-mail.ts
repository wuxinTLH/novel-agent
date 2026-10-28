import nodemailer from 'nodemailer';
import type { AccountEmailTransport } from './account-state.js';

export interface SmtpTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    disableFileAccess: boolean;
    disableUrlAccess: boolean;
  }): Promise<unknown>;
}
export type SmtpFactory = (options: {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
  tls: { rejectUnauthorized: true; minVersion: 'TLSv1.2' };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}) => SmtpTransport;
/** Explicit owner environment only. Does not enable auth or any account feature. Never logs tokens. */
export function createAccountEmailTransport(
  env: NodeJS.ProcessEnv = process.env,
  factory: SmtpFactory = (options) => nodemailer.createTransport(options),
): AccountEmailTransport | undefined {
  if (env.NOVEL_SMTP_ENABLED !== 'true') return undefined;
  const host = env.NOVEL_SMTP_HOST ?? '',
    user = env.NOVEL_SMTP_USER ?? '',
    pass = env.NOVEL_SMTP_PASSWORD ?? '',
    from = env.NOVEL_SMTP_FROM ?? '';
  const secure = env.NOVEL_SMTP_SECURE === 'true';
  const port = Number(env.NOVEL_SMTP_PORT ?? (secure ? '465' : '587'));
  if (
    !host ||
    host.length > 253 ||
    /[\s/@\\]/.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !user ||
    !pass ||
    !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from) ||
    /[\r\n]/.test(user)
  )
    throw new Error('ACCOUNT_SMTP_CONFIG_INVALID');
  const transport = factory({
    host,
    port,
    secure,
    requireTLS: !secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  return async (mail) => {
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(mail.to)) throw new Error('ACCOUNT_MAIL_ADDRESS_INVALID');
    const subject =
      mail.purpose === 'reset' ? 'Novel Agent password recovery' : 'Novel Agent email verification';
    // URL fragment avoids transmitting the token in HTTP paths or Referer headers.
    const text = `You requested an account action in Novel Agent.\n\nOpen this link within 15 minutes:\n${mail.url}\n\nOr paste this one-time token into account settings:\n${mail.token}\n\nIf you did not request this action, ignore this message. Never share this token.`;
    await transport.sendMail({
      from,
      to: mail.to,
      subject,
      text,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  };
}
