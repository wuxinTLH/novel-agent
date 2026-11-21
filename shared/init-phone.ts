/** Initialization deliberately supports only mainland China mobile and NANP numbers.
 * Syntax validation is not proof of assignment, ownership or SMS deliverability.
 */
export const INIT_PHONE_CODES = ['+86', '+1'] as const;
export type InitPhoneCode = typeof INIT_PHONE_CODES[number];

export function composeInitPhone(code: string, nationalNumber: string): string | null {
  if (code === '+86' && /^1[3-9][0-9]{9}$/.test(nationalNumber)) return code + nationalNumber;
  if (code === '+1' && /^[2-9][0-9]{2}[2-9][0-9]{6}$/.test(nationalNumber)) return code + nationalNumber;
  return null;
}

/** Use on canonical submitted values, not arbitrary globally formatted E.164. */
export function isSupportedInitPhone(value: string): boolean {
  return INIT_PHONE_CODES.some((code) => value.startsWith(code) && composeInitPhone(code, value.slice(code.length)) === value);
}
