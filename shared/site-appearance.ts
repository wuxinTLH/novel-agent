import { z } from 'zod';

const colorSchema = z.union([
  z.literal(''),
  z
    .string()
    .length(7)
    .regex(/^#[0-9a-fA-F]{6}$/),
]);

/** Only bounded presentation primitives; never CSS, HTML, URLs or executable content. */
export const navigationStyleSchema = z
  .object({
    backgroundColor: colorSchema,
    textColor: colorSchema,
    accentColor: colorSchema,
    borderColor: colorSchema,
    fontSize: z.number().int().min(12).max(24),
    paddingY: z.number().int().min(0).max(32),
  })
  .strict();
export type NavigationStyle = z.infer<typeof navigationStyleSchema>;
const companyNameSchema = z
  .string()
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value), 'Control characters are forbidden')
  .transform((value) => value.trim())
  .pipe(z.string().max(120));
const revisionSchema = z.number().int().nonnegative().safe();
export const siteAppearanceSchema = z
  .object({
    version: z.literal(1),
    revision: revisionSchema,
    companyName: companyNameSchema,
    header: navigationStyleSchema,
    footer: navigationStyleSchema,
  })
  .strict();
export type SiteAppearance = z.infer<typeof siteAppearanceSchema>;
export const updateSiteAppearanceSchema = z
  .object({
    expectedRevision: revisionSchema,
    companyName: companyNameSchema,
    header: navigationStyleSchema,
    footer: navigationStyleSchema,
  })
  .strict();
export type UpdateSiteAppearance = z.infer<typeof updateSiteAppearanceSchema>;
export function defaultSiteAppearance(): SiteAppearance {
  const style: NavigationStyle = {
    backgroundColor: '',
    textColor: '',
    accentColor: '',
    borderColor: '',
    fontSize: 14,
    paddingY: 16,
  };
  return { version: 1, revision: 0, companyName: '', header: { ...style }, footer: { ...style } };
}
