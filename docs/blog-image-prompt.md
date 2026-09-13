# Blog image prompt — Nano Banana template

A reusable prompt for generating blog lead images that stay in sync with each
other **and** match the Nourish the Nerve site theme. Paste the master prompt
below into Nano Banana (Gemini image generation), fill in the one `[SUBJECT]`
slot, attach the reference image, and generate.

> **Why a fixed template:** consistency comes from keeping *everything except
> the subject* identical every time — same art medium, same palette, same
> lighting, same composition rules, same reference image. Change only the
> `[SUBJECT]` line between posts and the whole set will look like one family.

---

## 1. The master prompt (copy this every time)

```text
Create a horizontal 16:9 editorial illustration to head a blog article for
Nourish the Nerve, a calm, warm UK neuro-rehabilitation clinic.

SUBJECT: [SUBJECT] — render this as the single, clear focal point.

ART STYLE: soft hand-painted watercolour and gouache, with gentle visible
brush texture and a subtle paper grain; loose organic edges; generous empty
space; a serene, unhurried, quietly hopeful mood. Weave in natural, botanical
motifs — leaves, branches, soft light — wherever they fit. This is elegant,
restful wellness editorial art. It must NOT look clinical, corporate, or like
a stock photo.

COLOUR PALETTE — use these soft, low-saturation washes and nothing brighter:
- warm off-white paper as the background (#f8f6f1)
- sage / olive green as the primary colour (#4e6136, with deeper #3a4a26)
- muted lavender as the single accent (#65558f)
- pale sage and pale lavender tints for light washes (#e3e9d7, #e9e2f4)
- warm charcoal for any fine linework (#232821)
Keep it gentle and muted throughout. No neon, no bright or high-contrast
colours, no pure black or pure white.

LIGHTING: soft, diffuse, natural early-morning daylight.

COMPOSITION: calm and balanced, with plenty of open space so a headline could
sit over part of it; one clear focal point; nothing cluttered.

DO NOT INCLUDE: any text, words, letters, or numbers; logos or watermarks;
identifiable human faces; medical equipment, hospitals, wheelchairs, needles,
scrubs, or anything sterile or clinical; harsh shadows; busy backgrounds;
photographic realism.

Output aspect ratio: 16:9.
```

---

## 2. How to use it each time

1. **Attach a reference image.** With the prompt, upload
   `apps/web/public/logo-mark.png` (the brain-leaf-in-hand mark) and add the
   line: *"Match the colour palette and soft watercolour style of the attached
   reference image."* This is the single biggest lever for keeping images in
   sync — the mark carries the exact lavender→sage gradient the palette is
   built from.
2. **For a matched set,** also attach the **previous post's image** and add:
   *"Keep the same art style, palette, and level of detail as this second
   reference image."*
3. **Fill the `[SUBJECT]` slot** with one plain sentence (examples below).
   Keep it concrete but calm — describe a quiet moment, not a dramatic one.
4. **Generate 3–4 options,** pick the calmest, and regenerate if any bright or
   clinical colours creep in (Nano Banana sometimes drifts — just say
   *"softer, more muted, warmer paper background"* and retry).

---

## 3. Filling the `[SUBJECT]` slot — worked examples

Keep people abstract (hands, silhouettes, from behind) so no identifiable face
appears — this both fits the theme and avoids the "DO NOT" list.

| Article about… | `[SUBJECT]` line |
| --- | --- |
| Gentle daily movement | a pair of hands doing a slow, gentle stretch, with a leaf motif |
| Recovery & patience | a single green shoot growing from a cupped hand |
| Rest & the nervous system | a warm cup of tea beside an open notebook on a sunlit windowsill |
| Balance / coordination | smooth river stones stacked in calm balance among leaves |
| Cognitive exercises | an abstract brain formed from soft overlapping leaves |
| Sleep & healing | a quiet bedside scene at dawn, soft light through a curtain |
| Walking / mobility | a calm empty footpath winding through a soft green park at sunrise |
| Community / support | two abstract figures walking together, seen from behind |

---

## 4. Other aspect ratios (when you need them)

Same prompt, just change the last line and the framing note:

- **Square thumbnail / social (1:1):** `Output aspect ratio: 1:1.` — keep the
  focal point centred so it survives cropping.
- **Portrait / phone (4:5):** `Output aspect ratio: 4:5.`
- The site's lead image renders full-width at the top of the post and as a
  card thumbnail in the list, so **16:9 is the default** — it reads well in
  both places.

---

## 5. Saving the result

- Export at roughly **1600 px wide**, as **WebP or JPEG** (keeps pages light —
  the site self-hosts everything and ships zero JS by default).
- Upload through the account **Blog / content** editor, which stores it in the
  media bucket and sets the post's `imageKey`. Give the post a real
  `imageAlt` describing the picture — the site uses one alt string per post.
- Suggested filename: `blog-<post-slug>-lead.webp`.

---

## 6. The theme, in one paragraph (the "why" behind the prompt)

Nourish the Nerve is a UK neuro-rehabilitation clinic, and the site is built to
feel *quiet, warm, and full of air — nothing shouting* (its design references
are Two Chairs and C Witt Counseling). The palette is **olive-and-lavender over
warm paper**: a deep sage/olive green for anything primary, a muted lavender
for the single accent, over a warm off-white ground rather than flat white.
Headings are set in the serif **Cormorant Garamond**, body text in **Inter**.
The brand mark is a brain that is also a leaf, cradled in a hand, painted as a
soft lavender-to-sage watercolour gradient. Every blog image should feel like
it came from the same hand that painted that mark: soft, botanical, unhurried,
and gentle.

*Palette tokens live in `packages/ui/src/tokens/color.ts`; fonts in
`apps/web/src/styles/fonts.css`.*
