# Brand & design source assets

Source and reference artwork for Nourish the Nerve — branding boards, the logo
lockup, the clean mark, the "what we offer" board, and some raw exports.

**These are kept here, not in `apps/web/public/`, on purpose.** Anything under
`apps/web/public/` is copied verbatim into the built site and uploaded to the
site bucket on every deploy. These files are large (tens of MB together) and
**nothing in the app references them** — they are design source, not web
assets. Left in `public/` they bloated the deploy bundle enough to stall the
CDK bucket-deployment step (that is why PR #227's ephemeral environment timed
out). They belong in version control for reference, but not in the deploy root.

If one of these ever needs to be served by the site, export or optimise the
specific asset the page needs into `apps/web/public/` under a real name — do
not point the site at a multi-megabyte source file here.
