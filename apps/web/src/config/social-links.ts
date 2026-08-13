// TASK 1.2.1: "configurable" means editing this array — Footer.astro only
// knows the SocialLink shape below, never a specific platform or handle.
// Parsed eagerly at import time (not lazily) so a malformed entry fails
// `astro build`, and every test that imports this module, rather than a
// runtime 500 in front of a real visitor.
//
// Real handles are a content/marketing decision, not an engineering one —
// the URLs below are placeholders (same "clearly a placeholder, not final"
// spirit as TASK 1.2.2's legal-page placeholders) pending the client
// confirming their actual profiles.
import { z } from 'zod';

export const socialLinkSchema = z.object({
  /** Proper-noun platform name (e.g. "Facebook") — a trademark, not translatable prose; same reasoning as site-config.ts's `siteName`. */
  label: z.string().min(1),
  href: z.string().url(),
});

export type SocialLink = z.infer<typeof socialLinkSchema>;

const rawSocialLinks: readonly SocialLink[] = [
  { label: 'Facebook', href: 'https://www.facebook.com/nourishthenerve' },
  { label: 'Instagram', href: 'https://www.instagram.com/nourishthenerve' },
];

export const socialLinks: readonly SocialLink[] = z.array(socialLinkSchema).parse(rawSocialLinks);
