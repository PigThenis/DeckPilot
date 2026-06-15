import { useCallback, useEffect, useRef, useState } from 'react';
import { deckNames, findNotes, notesInfo } from '../lib/anki';
import { deckQuery } from '../lib/queries';
import { noteToClean, spreadSample, type CleanCard } from '../lib/clean';
import { getClient, hasApiKey, DEFAULT_MODEL } from '../lib/llm';
import {
  applyTags,
  loadRuns,
  namespaced,
  removeAllPrefixed,
  undoRun,
  NEEDS_REVIEW,
  type TaggingRun,
} from '../lib/tagging';
import Combobox from './Combobox';
import ConfirmDialog from './ConfirmDialog';

type Phase = 'config' | 'taxonomy' | 'classify' | 'review' | 'done';
const REVIEW_PAGE = 50;

interface ConfirmState {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  confirmClass?: string;
  onConfirm: () => void;
}

export default function AiTagger({
  connectedAt,
  onBack,
}: {
  connectedAt: number | null;
  onBack: () => void;
}) {
  const keyPresent = hasApiKey();

  const [decks, setDecks] = useState<string[]>([]);
  const [deck, setDeck] = useState('');
  const [demo, setDemo] = useState(!keyPresent);
  const [prefix, setPrefix] = useState('ai::');
  const [sampleSize, setSampleSize] = useState(80);
  const [batchSize, setBatchSize] = useState(25);
  const [skipTagged, setSkipTagged] = useState(true);

  const [phase, setPhase] = useState<Phase>('config');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [taxonomyText, setTaxonomyText] = useState('');
  const [taxonomy, setTaxonomy] = useState<string[]>([]);

  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const cancelRef = useRef(false);
  const [proposals, setProposals] = useState<Record<number, string[]>>({});
  const [cardText, setCardText] = useState<Record<number, string>>({});
  const [batchErrors, setBatchErrors] = useState(0);
  const [reviewPage, setReviewPage] = useState(0);

  const [lastRun, setLastRun] = useState<TaggingRun | null>(null);
  const [runs, setRuns] = useState<TaggingRun[]>(() => loadRuns());
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  useEffect(() => {
    if (connectedAt == null) return;
    deckNames()
      .then((d) => setDecks([...d].sort((a, b) => a.localeCompare(b))))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [connectedAt]);

  const refreshRuns = useCallback(() => setRuns(loadRuns()), []);

  // Notes to operate on: deck cards, optionally excluding already-prefixed ones.
  const targetQuery = useCallback(() => {
    const root = prefix.replace(/::$/, '');
    return skipTagged ? `(${deckQuery(deck)}) -tag:${root}::*` : deckQuery(deck);
  }, [deck, prefix, skipTagged]);

  // --- Pass 1: propose taxonomy -------------------------------------------
  async function proposeTaxonomy() {
    setBusy(true);
    setError(null);
    try {
      const ids = await findNotes(targetQuery());
      if (ids.length === 0) {
        setError('No matching notes in that deck (all may already be tagged).');
        return;
      }
      const sampleIds = spreadSample(ids, sampleSize);
      const notes = await notesInfo(sampleIds);
      const clean = notes.map(noteToClean).filter((c) => c.text);
      const tags = await getClient(demo).proposeTaxonomy(clean);
      if (tags.length === 0) {
        setError('The model returned no taxonomy. Try a larger sample or check your key.');
        return;
      }
      setTaxonomyText(tags.join('\n'));
      setPhase('taxonomy');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function parseTaxonomy(): string[] {
    return [
      ...new Set(
        taxonomyText
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      ),
    ];
  }

  // --- Pass 2: classify ----------------------------------------------------
  async function classifyAll() {
    const tax = parseTaxonomy();
    if (tax.length === 0) {
      setError('Add at least one tag to the taxonomy.');
      return;
    }
    setTaxonomy(tax);
    setProposals({});
    setCardText({});
    setBatchErrors(0);
    setError(null);
    cancelRef.current = false;
    setPhase('classify');

    try {
      const ids = await findNotes(targetQuery());
      setProgress({ done: 0, total: ids.length });
      const client = getClient(demo);
      const nextProposals: Record<number, string[]> = {};
      const nextText: Record<number, string> = {};
      let errs = 0;

      for (let i = 0; i < ids.length; i += batchSize) {
        if (cancelRef.current) break;
        const batch = ids.slice(i, i + batchSize);
        const notes = await notesInfo(batch);
        const clean: CleanCard[] = notes.map(noteToClean);
        clean.forEach((c) => (nextText[c.noteId] = c.text));
        try {
          const res = await client.classify(clean, tax);
          for (const c of clean) nextProposals[c.noteId] = res[c.noteId] ?? [NEEDS_REVIEW];
        } catch {
          // Checkpoint per batch: flag this batch, keep going.
          errs += 1;
          for (const c of clean) nextProposals[c.noteId] = [NEEDS_REVIEW];
        }
        setProgress({ done: Math.min(i + batchSize, ids.length), total: ids.length });
        // Commit incrementally so a cancel still leaves a reviewable result.
        setProposals({ ...nextProposals });
        setCardText({ ...nextText });
        setBatchErrors(errs);
      }
      setReviewPage(0);
      setPhase('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('taxonomy');
    }
  }

  // --- Review editing ------------------------------------------------------
  function removeTagFromCard(noteId: number, tag: string) {
    setProposals((p) => ({ ...p, [noteId]: (p[noteId] ?? []).filter((t) => t !== tag) }));
  }

  const noteIds = Object.keys(proposals).map(Number);
  const taggable = noteIds.filter((id) =>
    (proposals[id] ?? []).some((t) => t !== NEEDS_REVIEW && taxonomy.includes(t))
  );
  const needsReview = noteIds.filter((id) => !taggable.includes(id));

  // Distribution of full (namespaced) tags across the approved proposals.
  const distribution = (() => {
    const m = new Map<string, number>();
    for (const id of taggable) {
      for (const t of proposals[id] ?? []) {
        if (t === NEEDS_REVIEW || !taxonomy.includes(t)) continue;
        const full = namespaced(prefix, t);
        m.set(full, (m.get(full) ?? 0) + 1);
      }
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  })();

  // --- Apply ---------------------------------------------------------------
  function askApply() {
    if (taggable.length === 0) return;
    const writes = distribution.reduce((n, [, c]) => n + c, 0);
    setConfirm({
      title: 'Apply tags?',
      body: (
        <p>
          This will add <span className="font-semibold tabular-nums">{writes}</span> tag
          assignments across{' '}
          <span className="font-semibold tabular-nums">{taggable.length}</span> cards, all under{' '}
          <code>{prefix}</code>. This writes to your real collection. You can undo this exact
          run afterward.
        </p>
      ),
      confirmLabel: 'Apply',
      confirmClass: 'bg-sky-600 hover:bg-sky-500',
      onConfirm: () => void doApply(),
    });
  }

  async function doApply() {
    setConfirm(null);
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: 0 });
    try {
      const run = await applyTags(deck, prefix, proposals, taxonomy, {
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setLastRun(run);
      refreshRuns();
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doUndo(runId: string) {
    setBusy(true);
    setError(null);
    try {
      await undoRun(runId);
      refreshRuns();
      if (lastRun?.id === runId) setLastRun(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function askRemoveAll() {
    setConfirm({
      title: `Remove all ${prefix} tags?`,
      body: (
        <p>
          This removes <span className="font-semibold">every</span> tag under{' '}
          <code>{prefix}</code> from your whole collection. This cannot be undone from here
          (your runs log will be cleared of effect). Continue?
        </p>
      ),
      confirmLabel: 'Remove all',
      confirmClass: 'bg-rose-600 hover:bg-rose-500',
      onConfirm: () => void doRemoveAll(),
    });
  }

  async function doRemoveAll() {
    setConfirm(null);
    setBusy(true);
    setError(null);
    try {
      const n = await removeAllPrefixed(prefix);
      setError(n === 0 ? `No ${prefix} tags found.` : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function resetToConfig() {
    setPhase('config');
    setProposals({});
    setCardText({});
    setTaxonomy([]);
    setTaxonomyText('');
    setLastRun(null);
    setError(null);
  }

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const realDisabled = !demo && !keyPresent;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <button
        type="button"
        onClick={onBack}
        className="mb-3 text-sm font-medium text-sky-700 hover:text-sky-800 hover:underline"
      >
        ← Back
      </button>

      <div className="mb-4">
        <h2 className="text-base font-semibold text-slate-900">Auto-tag a deck</h2>
        <p className="text-sm text-slate-500">
          Propose a tag vocabulary, review it, then apply tags — namespaced and reversible.
        </p>
      </div>

      {/* Privacy / mode notice */}
      <div
        className={`mb-4 rounded-xl p-3 text-sm ${
          demo ? 'bg-slate-50 text-slate-600' : 'bg-amber-50 text-amber-800'
        }`}
      >
        {demo ? (
          <>Demo mode: uses canned suggestions, makes no API calls and sends nothing off your machine.</>
        ) : (
          <>
            Tagging sends card text to OpenAI ({DEFAULT_MODEL}). Card content leaves your machine.
          </>
        )}
      </div>

      {error && (
        <p className="mb-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>
      )}

      {/* ---------------- CONFIG ---------------- */}
      {phase === 'config' && (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Deck</label>
            <Combobox
              options={decks}
              value={deck}
              onChange={setDeck}
              placeholder="Type to search decks…"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="text-sm">
              <span className="mb-1 block font-medium text-slate-700">Tag prefix</span>
              <input
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-slate-700">Sample size</span>
              <input
                type="number"
                value={sampleSize}
                min={10}
                max={300}
                onChange={(e) => setSampleSize(Number(e.target.value) || 80)}
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-slate-700">Batch size</span>
              <input
                type="number"
                value={batchSize}
                min={5}
                max={50}
                onChange={(e) => setBatchSize(Number(e.target.value) || 25)}
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5"
              />
            </label>
            <label className="flex items-end gap-2 text-sm">
              <input
                type="checkbox"
                checked={skipTagged}
                onChange={(e) => setSkipTagged(e.target.checked)}
                className="mb-2 h-4 w-4"
              />
              <span className="mb-1.5 font-medium text-slate-700">Skip already-tagged</span>
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={demo}
              disabled={!keyPresent}
              onChange={(e) => setDemo(e.target.checked)}
              className="h-4 w-4"
            />
            <span className="text-slate-700">
              Demo mode (no API calls){!keyPresent && ' — required: no API key found in .env'}
            </span>
          </label>

          {realDisabled && (
            <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
              To use a real model, set <code>VITE_OPENAI_API_KEY</code> in a <code>.env</code>{' '}
              file (see <code>.env.example</code>) and restart the dev server.
            </p>
          )}

          <button
            type="button"
            onClick={() => void proposeTaxonomy()}
            disabled={!deck || busy}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {busy ? 'Sampling…' : 'Propose taxonomy →'}
          </button>
        </div>
      )}

      {/* ---------------- TAXONOMY ---------------- */}
      {phase === 'taxonomy' && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Edit the proposed tag vocabulary (one tag per line, <code>parent::child</code>
            form). This is your main quality lever — fix duplicates/sprawl before classifying.
          </p>
          <textarea
            value={taxonomyText}
            onChange={(e) => setTaxonomyText(e.target.value)}
            spellCheck={false}
            rows={Math.min(16, Math.max(6, taxonomyText.split('\n').length + 1))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-slate-400 focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPhase('config')}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={() => void classifyAll()}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Approve &amp; classify →
            </button>
          </div>
        </div>
      )}

      {/* ---------------- CLASSIFY (progress) ---------------- */}
      {phase === 'classify' && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Classifying {progress.done} / {progress.total} cards…
            {batchErrors > 0 && (
              <span className="text-amber-700"> ({batchErrors} batch(es) flagged)</span>
            )}
          </p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div className="h-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <button
            type="button"
            onClick={() => (cancelRef.current = true)}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      )}

      {/* ---------------- REVIEW (dry-run) ---------------- */}
      {phase === 'review' && (
        <div className="space-y-4">
          <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
            <span className="font-semibold tabular-nums">{taggable.length}</span> cards will be
            tagged · <span className="tabular-nums">{needsReview.length}</span> need review
            (no tag) · <span className="tabular-nums">{distribution.length}</span> distinct tags
            {batchErrors > 0 && (
              <span className="text-amber-700"> · {batchErrors} batch error(s)</span>
            )}
          </div>

          {/* Tag distribution */}
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Tags to apply
            </div>
            <div className="flex flex-wrap gap-1.5">
              {distribution.map(([tag, count]) => (
                <span
                  key={tag}
                  className="rounded bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700"
                >
                  {tag} <span className="text-sky-400">×{count}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Per-card editable review (paginated) */}
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Per-card preview — click a tag to remove it
            </div>
            <ul className="divide-y divide-slate-100">
              {noteIds.slice(reviewPage * REVIEW_PAGE, (reviewPage + 1) * REVIEW_PAGE).map((id) => (
                <li key={id} className="py-2">
                  <div className="truncate text-sm text-slate-600" title={cardText[id]}>
                    {cardText[id] || <span className="italic text-slate-400">(empty)</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(proposals[id] ?? []).filter((t) => t !== NEEDS_REVIEW).length === 0 ? (
                      <span className="text-xs italic text-amber-600">needs review</span>
                    ) : (
                      (proposals[id] ?? [])
                        .filter((t) => t !== NEEDS_REVIEW)
                        .map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => removeTagFromCard(id, t)}
                            title="Remove this tag"
                            className="rounded bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-700 hover:bg-rose-50 hover:text-rose-600"
                          >
                            {namespaced(prefix, t)} ✕
                          </button>
                        ))
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {noteIds.length > REVIEW_PAGE && (
              <div className="mt-2 flex items-center justify-between text-sm">
                <span className="text-slate-400">
                  {reviewPage * REVIEW_PAGE + 1}–
                  {Math.min(noteIds.length, (reviewPage + 1) * REVIEW_PAGE)} of {noteIds.length}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setReviewPage((p) => Math.max(0, p - 1))}
                    disabled={reviewPage === 0}
                    className="rounded-lg border border-slate-300 px-3 py-1 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setReviewPage((p) =>
                        (p + 1) * REVIEW_PAGE < noteIds.length ? p + 1 : p
                      )
                    }
                    disabled={(reviewPage + 1) * REVIEW_PAGE >= noteIds.length}
                    className="rounded-lg border border-slate-300 px-3 py-1 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPhase('taxonomy')}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              ← Edit taxonomy
            </button>
            <button
              type="button"
              onClick={askApply}
              disabled={taggable.length === 0 || busy}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              Apply to {taggable.length} cards
            </button>
          </div>
        </div>
      )}

      {/* ---------------- DONE ---------------- */}
      {phase === 'done' && lastRun && (
        <div className="space-y-3">
          {busy ? (
            <>
              <p className="text-sm text-slate-600">
                Applying… {progress.done}/{progress.total}
              </p>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div className="h-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
              Tagged <span className="font-semibold">{lastRun.noteCount}</span> cards with{' '}
              <span className="font-semibold">{lastRun.tagCount}</span> distinct tags under{' '}
              <code>{lastRun.prefix}</code>.
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void doUndo(lastRun.id)}
                  className="rounded-lg border border-emerald-300 px-3 py-1.5 font-medium hover:bg-emerald-100"
                >
                  Undo this run
                </button>
                <button
                  type="button"
                  onClick={resetToConfig}
                  className="rounded-lg bg-slate-900 px-3 py-1.5 font-medium text-white hover:bg-slate-700"
                >
                  Tag another deck
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---------------- RUN HISTORY + ESCAPE HATCH ---------------- */}
      {(phase === 'config' || phase === 'done') && (
        <div className="mt-6 border-t border-slate-200 pt-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700">Tag runs</h3>
            <button
              type="button"
              onClick={askRemoveAll}
              disabled={busy}
              className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-50"
            >
              Remove ALL {prefix} tags
            </button>
          </div>
          {runs.length === 0 ? (
            <p className="text-xs text-slate-400">No runs yet.</p>
          ) : (
            <ul className="space-y-1">
              {runs.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate text-slate-600" title={r.deck}>
                    {new Date(r.ts).toLocaleString()} · {r.noteCount} cards · {r.deck}
                  </span>
                  <button
                    type="button"
                    onClick={() => void doUndo(r.id)}
                    disabled={busy}
                    className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-white disabled:opacity-50"
                  >
                    Undo
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirm != null}
        title={confirm?.title ?? ''}
        body={confirm?.body}
        confirmLabel={confirm?.confirmLabel ?? 'Confirm'}
        confirmClass={confirm?.confirmClass}
        busy={busy}
        onConfirm={() => confirm?.onConfirm()}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
