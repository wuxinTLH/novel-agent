import type { RoleId } from './permissions.js';
export type AuthRole = RoleId;
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
/** Non-bearer handle; never exposes a session cookie, token hash or CSRF token. */
export interface AuthSessionInfo {
  id: string;
  expiresAt: string;
  current: boolean;
}
export interface AuthPasswordChange {
  currentPassword: string;
  newPassword: string;
}
export interface AuthUserUpdate {
  disabled?: boolean;
  role?: AuthRole;
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
