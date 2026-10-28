import { z } from 'zod';

const oidc = z.object({
  enabled: z.boolean().default(false),
  issuer: z.string().max(2048).default(''),
  clientId: z.string().max(256).default(''),
  encryptedClientSecret: z.string().max(4096).default(''),
  authorizationEndpoint: z.string().max(2048).default(''),
  tokenEndpoint: z.string().max(2048).default(''),
  jwksUri: z.string().max(2048).default(''),
  redirectUri: z.string().max(2048).default(''),
});
export const accountStateSchema = z.object({
  config: z
    .object({
      registration: z.boolean().default(false),
      emailVerification: z.boolean().default(false),
      passwordRecovery: z.boolean().default(false),
      mfa: z.boolean().default(false),
      publicOrigin: z.string().max(2048).default(''),
      oidc: oidc.default(() => oidc.parse({})),
    })
    .default(() => ({
      registration: false,
      emailVerification: false,
      passwordRecovery: false,
      mfa: false,
      publicOrigin: '',
      oidc: oidc.parse({}),
    })),
  profiles: z
    .array(
      z.object({
        userId: z.string().uuid(),
        email: z.string().email().max(254).optional(),
        verified: z.boolean().default(false),
        encryptedTotp: z.string().max(4096).optional(),
        lastCounter: z.number().int().default(-1),
        recoveryHashes: z.array(z.string().length(64)).max(20).default([]),
        oidcSubject: z.string().max(512).optional(),
        oidcIssuer: z.string().max(2048).optional(),
      }),
    )
    .max(10000)
    .default([]),
  tokens: z
    .array(
      z.object({
        hash: z.string().length(64),
        kind: z.enum(['register', 'email', 'reset', 'mfa', 'setup', 'oidc']),
        expires: z.number(),
        userId: z.string().optional(),
        payload: z.record(z.string(), z.string()).default({}),
      }),
    )
    .max(20000)
    .default([]),
});
export type AccountState = z.infer<typeof accountStateSchema>;
export type AccountConfig = AccountState['config'];
export interface AccountMail {
  to: string;
  purpose: 'register' | 'email' | 'reset';
  /** Raw token is delivered only to the configured mail transport, never the API response. */
  token: string;
  url: string;
}
export type AccountEmailTransport = (mail: AccountMail) => Promise<void>;
export const emptyAccountState = (): AccountState => accountStateSchema.parse({});
