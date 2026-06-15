# DeckPilot

A local, single-user **management cockpit** for your spaced-repetition decks. It reads
your decks and cards and lets you do the high-level chores — browse card contents, see
where you stand, bulk suspend/unsuspend by tag or deck, and auto-tag with AI —
**without** opening the intimidating native UI.

> DeckPilot communicates with **your own** Anki desktop via the AnkiConnect add-on over
> its documented HTTP API. It is **not affiliated with, endorsed by, or derived from
> Anki**, and contains no Anki source code.

**What it is not:** not a flashcard reviewer (keep doing daily review in native Anki),
not a replacement for Anki, not a card generator, not cloud/multi-user. Everything runs
locally on your machine. There is no backend, no database, and nothing is stored by us.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| [Anki desktop](https://apps.ankiweb.net/) | Must be open whenever you use DeckPilot |
| [AnkiConnect add-on](https://ankiweb.net/shared/info/2055492159) | Code `2055492159` — installed from inside Anki |
| [Node.js](https://nodejs.org/) v18 or later | Run `node -v` to check |

### Install AnkiConnect (one-time)

1. In Anki: **Tools → Add-ons → Get Add-ons…**
2. Paste code **`2055492159`** and click OK.
3. **Restart Anki.** AnkiConnect will serve its API on `http://127.0.0.1:8765`.

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/PigThenis/DeckPilot.git
cd DeckPilot/deckpilot

# 2. Install dependencies
npm install

# 3. Start the dev server
npm run dev
```

Open the URL Vite prints (default `http://localhost:5173`). With Anki open and AnkiConnect
installed, the top panel will show **Connected** and your decks will load.

---

## Features

| Panel | What it does |
|---|---|
| **Connection status** | Live Connected / Not-connected dot, AnkiConnect version, Retry button, and context-aware help |
| **Deck overview** | Full collapsible deck hierarchy matching Anki's `Parent::Child::Grandchild` structure; click any deck to browse its cards |
| **Card Browser** | Paginated card list (50/page); click a card to see its rendered front and back in a sandboxed iframe, with images displayed inline; Prev/Next navigation |
| **Turn cards on/off** | Pick a tag or deck, see how many cards are active vs. suspended, then bulk-suspend or unsuspend with one confirmed click — plus one-click Undo |
| **Analytics** | Cards reviewed today, new cards waiting, active vs. suspended totals, and a plain-English verdict on whether you're keeping up |
| **AI Tagging** | Two-pass wizard: propose a content-derived tag taxonomy from a sample, classify all notes, review per-card assignments, then apply — with Undo and a "Remove ALL ai:: tags" escape hatch |

---

## AI Tagging

Turns an untagged or messy deck into a consistent, hierarchical tag set so the
suspend/unsuspend-by-tag features become useful. It **never writes tags silently**:

1. **Propose** — samples cards and asks the model for a tag vocabulary (`parent::child`).  
   You see and edit the proposed taxonomy before anything is classified.
2. **Classify** — each card gets matched to the approved vocabulary. Off-list tags are
   dropped; cards that fit nothing are flagged `__needs_review__`.
3. **Review** — per-card tag assignments shown in full; click ✕ on any tag to remove it
   before writing.
4. **Apply** — tags written in batches under a namespace prefix (default `ai::`), with a
   per-run **Undo** and a **"Remove ALL ai:: tags"** escape hatch.

**Demo mode** (a checkbox in the config step) runs the entire flow with canned data —
zero API calls, nothing leaves your machine. Use it to try the UI for free.

### Setup (OpenAI key)

1. Copy `.env.example` to `.env.local` in the `deckpilot/` directory:

   ```powershell
   # PowerShell
   Copy-Item .env.example .env.local
   ```

   ```bash
   # macOS / Linux
   cp .env.example .env.local
   ```

2. Open `.env.local` and fill in your key:

   ```
   VITE_OPENAI_API_KEY=sk-...your-key-here...
   ```

3. **Restart** `npm run dev` so Vite picks up the new variable. The AI Tagging panel will
   show **"API key detected"**.

Calls are routed through a `/openai` dev proxy in `vite.config.ts` — no browser CORS.  
`.env.local` is gitignored; your key is never committed.

### Privacy

With a real key, **Pass 1 and Pass 2 send card text to OpenAI**. This is the only feature
that sends content off your machine. The UI states this clearly; demo mode keeps everything
local.

---

## Safety — this changes your real collection

Suspend/unsuspend changes your actual Anki scheduling. DeckPilot treats every mutation as
consequential:

- **Sync to AnkiWeb first** (or export a `.colpkg` backup) before bulk changes.
- Every bulk action shows a **confirmation dialog** with the exact count and direction
  before writing anything.
- Every action offers a one-click **Undo** immediately after.
- Nothing is ever changed automatically — all actions are user-initiated.
- Changes happen in **desktop** Anki; sync the desktop afterward for them to reach
  AnkiWeb / your phone.

---

## Connectivity & CORS

DeckPilot routes all AnkiConnect calls through the Vite dev-server proxy at `/anki → http://127.0.0.1:8765`.
Because the proxy makes the request server-side it carries no browser `Origin` header, so
AnkiConnect accepts it without any config change. Running `npm run dev` should just work.

### "Connected" never appears — troubleshooting

- Make sure Anki is **open** (not minimised to tray / closed).
- Confirm AnkiConnect appears in **Tools → Add-ons** and shows no errors.
- Try restarting Anki.
- Check nothing else is listening on port `8765` (`netstat -ano | findstr 8765` on Windows).

### macOS — App Nap

App Nap can suspend AnkiConnect when Anki is in the background, making requests hang.
Disable it once, then restart Anki:

```bash
defaults write net.ichi2.anki NSAppSleepDisabled -bool true
```

### For built / deployed versions

If you `npm run build` and serve from a different origin, add it to AnkiConnect's
allow-list: **Tools → Add-ons → AnkiConnect → Config**:

```json
{ "webCorsOriginList": ["http://localhost", "http://localhost:5173"] }
```

Then restart Anki.

---

## Project Layout

```
deckpilot/
├── src/
│   ├── components/
│   │   ├── AiTagger.tsx         # AI tagging wizard (config → taxonomy → classify → review → done)
│   │   ├── Analytics.tsx        # Stats panel (reviewed today, active, suspended)
│   │   ├── CardBrowser.tsx      # Card list + detail view with sandboxed iframe rendering
│   │   ├── Combobox.tsx         # Typable filtered dropdown (tag/deck pickers)
│   │   ├── ConfirmDialog.tsx    # Reusable confirm modal with busy state
│   │   ├── ConnectionStatus.tsx # AnkiConnect live status + retry
│   │   ├── DeckOverview.tsx     # Collapsible deck tree; click to browse
│   │   └── SuspendManager.tsx   # Bulk suspend/unsuspend by tag or deck
│   ├── hooks/
│   │   └── useConnection.ts     # AnkiConnect connection state hook
│   ├── lib/
│   │   ├── anki.ts              # All AnkiConnect calls (serialized request queue)
│   │   ├── clean.ts             # Card text normalisation for AI input
│   │   ├── llm.ts               # OpenAI client + Demo client; model config
│   │   ├── queries.ts           # AnkiConnect search query builders (escaping, deck:, tag:)
│   │   └── tagging.ts           # Tag application, run log (localStorage), undo
│   ├── App.tsx                  # Top-level view router (dashboard / browse / tagging)
│   ├── main.tsx
│   ├── index.css
│   └── vite-env.d.ts            # VITE_OPENAI_API_KEY type declaration
├── .env.example                 # Key template — safe to commit; copy to .env.local
├── vite.config.ts               # Proxies /anki → AnkiConnect, /openai → OpenAI
├── tailwind.config.js
├── postcss.config.js
└── package.json
```
