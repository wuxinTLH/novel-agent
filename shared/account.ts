/** All account capabilities are administrator configured and default off. */
export interface AccountFeatures {
  registration: boolean;
  emailVerification: boolean;
  passwordRecovery: boolean;
  mfa: boolean;
  oidc: boolean;
}
export interface AccountSettings {
  email: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  recoveryCodesRemaining: number;
}
export interface AccountOidcConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  redirectUri: string;
  hasClientSecret: boolean;
}
export interface AccountAdminConfig extends Omit<AccountFeatures, 'oidc'> {
  publicOrigin: string;
  oidc: AccountOidcConfig;
}
export interface MfaEnrollment {
  token: string;
  secret: string;
  uri: string;
}
export interface AccountMfaPending {
  mfaRequired: true;
}
