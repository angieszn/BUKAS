# Bukas

Plain HTML, CSS and JavaScript. No build step, no framework.

## Going live

See **DEPLOY.md** for Supabase + Vercel, step by step.

## Setup (local)

1. Open `schema.sql` and run it once in the Supabase SQL editor.
2. Open `config.js` and paste your project URL and anon key.
   (Supabase dashboard → Project Settings → API)
3. Serve the folder over http (`npx serve .`) and open it on your phone.

Until step 2 is done the app runs against browser localStorage so you can use
it end to end. Email confirmation: if your project requires it, sign-up shows
"Confirm your email, then sign in."

## Files

- `index.html` — all eight screens, one document
- `styles.css` — the paper/ink system
- `app.js` — return algorithm, delivery metering, prompts, store adapters- `config.js` — your two credentials, nowhere else
- `schema.sql` — table, indexes, row-level security

## The return algorithm (`app.js`, top of file)

`drawReturnAt()` runs once, at seal time, and the result is never
recalculated. It draws a random exponent between 14 days and 5 years, so
every timescale carries equal weight: ~38% return within 3 months, ~29%
within a year, ~33% beyond, with a real long tail out to five years. A user's
first entry draws from 3 days instead of 14.

`pickDelivery()` treats `return_at` as eligibility, not delivery. It refuses
to deliver within 5 days of the last return, skips any entry whose
anniversary falls today, and about 1 in 5 times pairs a second eligible entry
matched structurally — same weekday, or written within 75 minutes of the same
clock time. Never by content.

## Prompts

50 questions in eight internal groups. One shuffled queue per group, so
nothing repeats until its own group has cycled. Each time Compose opens there
is a 40% roll; if it lands, the group is weighted first — ordinary about 1 in
6, the other seven evenly — and the prompt is drawn from it. Groups are never shown, never stored and
never counted — only `prompt_text` is kept on the row, so a returning entry
carries its question back with it. A dismissed prompt is cleared from the
draft as well as the screen.

## Password reset

Supabase → Authentication → URL Configuration: add the address you serve
Bukas from to **Redirect URLs**, or reset links will be rejected. The link
lands back on Bukas and opens the new-password screen.

## Testing without waiting

Two console-only helpers, deliberately absent from the interface:

    __bukas.due()            // make every sealed entry eligible now
    __bukas.distribution()   // sanity-check the draw over 10,000 samples

## One added column

`delivered_at` is not in your data spec. The 5-day delivery meter needs a
record of when the last return actually landed — `return_at` alone can't
express it. It holds a single timestamp per delivered entry and is never
aggregated or shown.

## Two decisions the brief left open

- **"Seal it again" vs "Not now."** Both defer and neither is counted.
  Seal it again re-draws under the full 14-day–5-year rule. Not now draws
  short (5 days–18 months) — it pushes the entry out of today rather than
  out of the year.
- **Deferral re-draws `return_at`.** The "never recalculate" rule protects
  the system from holding an opinion about you; a deferral is your action,
  not the system's, so it draws a fresh date the same way a seal does.
