export type AuthRole = 'superadmin' | 'user';
export interface AuthUser {
  id: string;
  username: string;
  role: AuthRole;
  disabled: boolean;
  createdAt: string;
}
export interface AuthPrincipal extends AuthUser {
  csrfToken: string;
}
export interface AuthSession {
  user: AuthUser;
  csrfToken: string;
  expiresAt: string;
}
export interface TurnstilePublicSettings {
  enabled: boolean;
  siteKey: string;
  action: string;
  hostname: string;
}
export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
  user: AuthUser | null;
  csrfToken?: string;
  turnstile: TurnstilePublicSettings;
}
export interface TurnstileAdminSettings extends TurnstilePublicSettings {
  hasSecret: boolean;
}
