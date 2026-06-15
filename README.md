# DeckPilot

A local, single-user **management cockpit** for your spaced-repetition decks. It reads
your decks and cards and lets you do the high-level chores — see where you stand and
bulk suspend/unsuspend by tag or deck — **without** opening the intimidating native UI.

> DeckPilot communicates with **your own** Anki desktop via the AnkiConnect add-on over
> its documented HTTP API. It is **not affiliated with, endorsed by, or derived from
> Anki**, and contains no Anki source code.

**What it is not:** not a flashcard reviewer (keep doing daily review in native Anki),
not a replacement for Anki, not a card generator, not cloud/multi-user. Everything runs
locally on your machine. There is no backend, no database, and nothing is stored by us.

---

## Prerequisites

1. **Anki desktop**, installed and **running**. DeckPilot cannot talk to a closed Anki.
2. **The AnkiConnect add-on.** In Anki: **Tools → Add-ons → Get Add-ons…**, paste the
   code **`2055492159`**, click OK, then **restart Anki**. AnkiConnect serves an HTTP
   API on `http://127.0.0.1:8765` (localhost only).
3. **Node.js 18+**.

## Run it

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default `http://localhost:5173`). With Anki open and
AnkiConnect installed, the top panel will show **Connected** and your decks will load.

## The four panels

- **Connection status** — live Connected / Not-connected indicator, AnkiConnect version,
  and a Retry button.
- **Deck overview** — each deck with its New / Learning / Due counts, in plain language.
- **Suspend / Unsuspend manager** — pick a tag *or* a deck, see how many cards match and
  how many are currently suspended, then bulk suspend or unsuspend with one confirmed
  click (with Undo).
- **Analytics** — cards reviewed today, active vs suspended totals, and a one-line
  "are you keeping up?" readout.
- **Card View** — click a deck to open its own page: a paginated card list, then a card's
  real rendered front/back (in a sandboxed iframe, with images inlined) plus its tags.
- **AI Tagging** — give a deck a clean, hierarchical tag structure automatically. Strictly
  **propose → review → apply** (see below).

---

## AI Tagging

Turns an untagged/messy deck into a consistent, hierarchical tag set so the
suspend/unsuspend-by-tag features become useful. It **never writes tags silently**:

1. **Propose** — samples cards and asks the model for a tag vocabulary (`parent::child`).
2. **Review** — you edit/approve that vocabulary, then see per-card suggestions and can
   remove any before writing.
3. **Apply** — only approved tags are written, namespaced under a prefix (default `ai::`),
   in batches, with a one-click **Undo run** and a **"Remove ALL `ai::` tags"** escape hatch.

Pass 2 is locked to the approved vocabulary — off-list tags are dropped, and cards that fit
nothing are flagged "needs review" rather than mis-tagged.

### Setup (OpenAI)

1. Copy `.env.example` to `.env` and set your key:
   ```
   VITE_OPENAI_API_KEY=sk-...
   # optional: VITE_OPENAI_MODEL=gpt-5.4-nano-2026-03-17   (default)
   ```
2. Restart `npm run dev` (Vite only reads `.env` at startup).

Calls are routed through a `/openai` dev proxy (in `vite.config.ts`) to avoid browser CORS.
`.env` is gitignored — your key is never committed. **Demo mode** (a checkbox, and the only
option when no key is set) runs the whole flow with canned suggestions — no API calls, no
data leaves your machine — so you can try it for free.

### Privacy

With a real key, **tagging sends card text to OpenAI** — the first feature that sends
content off your machine. The UI states this; demo mode keeps everything local.

### Safety note

This build uses light gating (dry-run + explicit confirm + per-run Undo + escape hatch); it
does **not** require a `__SANDBOX_OK__` deck or auto-export a backup. **Sync to AnkiWeb or
export a backup `.colpkg` before a large run.** Close Anki's Browse window before applying
(open notes may not refresh).

---

## Connectivity & CORS (read if "Connected" never appears)

AnkiConnect only accepts **browser** requests from origins it trusts (localhost by
default), so a browser app can hit a CORS wall. DeckPilot avoids this two ways:

### Default: the Vite dev-server proxy (no Anki config needed)

`vite.config.ts` proxies the same-origin path `/anki` to `http://127.0.0.1:8765`.
Because the proxy makes the request **server-side**, it carries no browser `Origin`
header, so AnkiConnect accepts it (the same reason `curl` works against it). This is the
default transport — running `npm run dev` should just work.

### Fallback: allow your origin in AnkiConnect (for builds / deploys)

If you build the app and serve it from some other origin, add that origin to
AnkiConnect's allow-list: **Tools → Add-ons → AnkiConnect → Config**, add your URL to
`webCorsOriginList`, e.g.:

```json
{ "webCorsOriginList": ["http://localhost", "http://localhost:5173"] }
```

then **restart Anki**. The transport base URL is centralised in `src/lib/anki.ts`
(`setBaseUrl`) if you need to point at a direct endpoint instead of the proxy.

### macOS gotcha — App Nap

On macOS, App Nap can suspend AnkiConnect when Anki is in the background, making requests
hang. Fix it once in Terminal, then restart Anki:

```bash
defaults write net.ichi2.anki NSAppSleepDisabled -bool true
```

---

## Safety — this changes your real collection

Suspend / unsuspend changes your actual scheduling. DeckPilot treats every mutation as
consequential:

- **Sync to AnkiWeb first** so you have a backup before bulk changes.
- Every bulk change is **confirmed** beforehand (showing the exact count, target, and
  direction) and offers a one-click **Undo** afterward.
- Nothing is ever changed automatically — all actions are user-initiated.
- Changes you make here happen in **desktop** Anki; **sync from the desktop** afterward
  for them to reach your phone.

---

## Project layout

```
vite.config.ts            # includes the /anki proxy
src/
  lib/anki.ts             # the ONLY place that talks to AnkiConnect; typed wrappers
  lib/queries.ts          # build & escape Anki search queries
  hooks/useConnection.ts  # connection status + retry
  components/
    ConnectionStatus.tsx
    DeckOverview.tsx
    SuspendManager.tsx
    Analytics.tsx
    ConfirmDialog.tsx
  App.tsx
```
