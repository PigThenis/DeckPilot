import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cardsInfo,
  findCards,
  notesInfo,
  retrieveMediaFile,
  type FieldValue,
} from '../lib/anki';

const PAGE_SIZE = 50;

// Resolved media, keyed by filename: a data: URI, or null if missing/failed.
// Module-level so it persists across cards within a session.
const mediaCache = new Map<string, string | null>();

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Pull <img> src filenames out of rendered card HTML. */
function imageFilenames(html: string): string[] {
  const out = new Set<string>();
  const re = /<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let f = m[1].replace(/&amp;/g, '&');
    try {
      f = decodeURIComponent(f);
    } catch {
      /* keep raw */
    }
    if (!/^(data:|https?:|file:)/i.test(f)) out.add(f);
  }
  return [...out];
}

export interface BrowseRequest {
  query: string;
  label: string;
  /** Bumped on every selection so re-clicking the same deck reloads. */
  nonce: number;
}

interface CardDetail {
  cardId: number;
  note: number;
  tags: string[];
  question: string;
  answer: string;
  modelName: string;
}

interface ListItem {
  cardId: number;
  preview: string;
  tags: string[];
}

/** Value of the note's first field (display order 0). */
function firstFieldValue(fields: Record<string, FieldValue>): string {
  let best: FieldValue | undefined;
  for (const f of Object.values(fields)) {
    if (best === undefined || f.order < best.order) best = f;
  }
  return best?.value ?? '';
}

/** Turn field HTML into a short plain-text preview without firing media requests. */
function htmlToPreview(html: string): string {
  const noTags = html.replace(/<[^>]*>/g, ' ');
  const ta = document.createElement('textarea');
  ta.innerHTML = noTags;
  return ta.value
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Neutralize template HTML and inline resolved images for the sandboxed iframe. */
function sanitizeForIframe(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<img\b[^>]*>/gi, (tag) => {
    const m = tag.match(/\ssrc\s*=\s*["']([^"']+)["']/i);
    if (!m) return '<span style="color:#94a3b8">[image]</span>';
    let file = m[1].replace(/&amp;/g, '&');
    try {
      file = decodeURIComponent(file);
    } catch {
      /* keep raw */
    }
    if (/^(data:|https?:|file:)/i.test(file)) {
      return `<img src="${file}" style="max-width:100%;height:auto" alt="">`;
    }
    const entry = mediaCache.get(file);
    if (entry) return `<img src="${entry}" style="max-width:100%;height:auto" alt="">`;
    if (entry === null) return `<span style="color:#94a3b8">[missing image]</span>`;
    return `<span style="color:#94a3b8">[loading image…]</span>`;
  });
}

function iframeDoc(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
  <style>html,body{margin:0;padding:12px;font-family:ui-sans-serif,system-ui,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a;font-size:15px;line-height:1.5;word-wrap:break-word}</style>
  </head><body>${sanitizeForIframe(html)}</body></html>`;
}

/**
 * A card-content frame that grows to fit its content so tall images (e.g. anatomy
 * diagrams) are fully visible instead of clipped. Uses sandbox="allow-same-origin"
 * — which still keeps SCRIPTS disabled (the real protection) — so the parent can
 * read the rendered height. Re-measures as inlined images decode.
 */
function CardFrame({ doc, title }: { doc: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(96);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    let ro: ResizeObserver | undefined;
    const measure = () => {
      try {
        const d = iframe.contentDocument;
        if (!d?.body) return;
        const h = Math.max(d.documentElement?.scrollHeight ?? 0, d.body.scrollHeight);
        if (h > 0) setHeight(Math.min(h + 4, 4000));
      } catch {
        /* opaque origin — leave default height */
      }
    };
    const onLoad = () => {
      measure();
      try {
        const body = iframe.contentDocument?.body;
        if (body && 'ResizeObserver' in window) {
          ro = new ResizeObserver(() => measure());
          ro.observe(body);
        }
      } catch {
        /* ignore */
      }
    };
    iframe.addEventListener('load', onLoad);
    measure();
    return () => {
      iframe.removeEventListener('load', onLoad);
      ro?.disconnect();
    };
  }, [doc]);

  return (
    <iframe
      ref={ref}
      title={title}
      sandbox="allow-same-origin"
      srcDoc={doc}
      scrolling="no"
      style={{ height }}
      className="w-full rounded-lg border border-slate-200 bg-white"
    />
  );
}

function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) {
    return <span className="text-xs italic text-slate-400">no tags</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span
          key={t}
          className="rounded bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-700"
        >
          {t}
        </span>
      ))}
    </span>
  );
}

/** Card View page — read-only: browse a deck's (or a search's) cards and inspect one. */
export default function CardBrowser({
  request,
  onBack,
}: {
  request: BrowseRequest | null;
  onBack: () => void;
}) {
  const [input, setInput] = useState('');
  const [activeLabel, setActiveLabel] = useState<string | null>(null);

  const [cardIds, setCardIds] = useState<number[] | null>(null);
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The card being inspected, as a global index into cardIds (enables Prev/Next).
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Bumped as images resolve, to re-render the iframes with inlined media.
  const [mediaTick, setMediaTick] = useState(0);

  // Fetch previews for one page of IDs (page-only — never the whole deck).
  const loadPage = useCallback(async (ids: number[], p: number) => {
    setLoading(true);
    setError(null);
    try {
      const pageIds = ids.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
      const cards = await cardsInfo(pageIds);
      const noteIds = [...new Set(cards.map((c) => c.note))];
      const notes = await notesInfo(noteIds);
      const tagsByNote = new Map(notes.map((n) => [n.noteId, n.tags]));
      const list: ListItem[] = cards.map((c) => ({
        cardId: c.cardId,
        preview: htmlToPreview(firstFieldValue(c.fields)),
        tags: tagsByNote.get(c.note) ?? [],
      }));
      setItems(list);
      setPage(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const runSearch = useCallback(
    async (query: string, label: string) => {
      setActiveLabel(label);
      setSelectedIndex(null);
      setDetail(null);
      setItems(null);
      setCardIds(null);
      setError(null);
      if (!query.trim()) return;
      setLoading(true);
      try {
        const ids = await findCards(query);
        setCardIds(ids);
        if (ids.length > 0) await loadPage(ids, 0);
        else setLoading(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    },
    [loadPage]
  );

  // React to a deck selection from the overview.
  useEffect(() => {
    if (!request) return;
    setInput(request.query);
    void runSearch(request.query, request.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce]);

  // Load the inspected card's full detail whenever the selected index changes.
  useEffect(() => {
    if (selectedIndex == null || !cardIds) {
      setDetail(null);
      return;
    }
    const id = cardIds[selectedIndex];
    if (id == null) return;
    let cancelled = false;
    (async () => {
      setDetailLoading(true);
      setError(null);
      try {
        const [c] = await cardsInfo([id]);
        const notes = c ? await notesInfo([c.note]) : [];
        if (cancelled) return;
        setDetail(
          c
            ? {
                cardId: c.cardId,
                note: c.note,
                tags: notes[0]?.tags ?? [],
                question: c.question,
                answer: c.answer,
                modelName: c.modelName,
              }
            : null
        );
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedIndex, cardIds]);

  // Fetch + inline images for the open card (progressive: placeholders fill in).
  useEffect(() => {
    if (!detail) return;
    const files = imageFilenames(detail.question + detail.answer).filter(
      (f) => !mediaCache.has(f)
    );
    if (files.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const f of files) {
        try {
          const data = await retrieveMediaFile(f);
          mediaCache.set(f, data ? `data:${mimeFromName(f)};base64,${data}` : null);
        } catch {
          mediaCache.set(f, null);
        }
        if (!cancelled) setMediaTick((t) => t + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detail]);

  const frontDoc = useMemo(
    () => (detail ? iframeDoc(detail.question) : ''),
    [detail, mediaTick]
  );
  const backDoc = useMemo(() => (detail ? iframeDoc(detail.answer) : ''), [detail, mediaTick]);

  const total = cardIds?.length ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    void runSearch(input, input.trim());
  }

  function backToList() {
    // Sync the list to the page that holds the card we were viewing.
    if (selectedIndex != null && cardIds) {
      const p = Math.floor(selectedIndex / PAGE_SIZE);
      if (p !== page) void loadPage(cardIds, p);
    }
    setSelectedIndex(null);
  }

  const inDetail = selectedIndex != null;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      {/* Breadcrumb back to the dashboard */}
      <button
        type="button"
        onClick={onBack}
        className="mb-3 text-sm font-medium text-sky-700 hover:text-sky-800 hover:underline"
      >
        ← Decks
      </button>

      <div className="mb-3">
        <h2 className="text-base font-semibold text-slate-900">Browse cards</h2>
        <p className="text-sm text-slate-500">
          Click a card to see what's on it, or search to narrow things down.
        </p>
      </div>

      {/* Search box */}
      <form onSubmit={submitSearch} className="mb-4 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Anki search, e.g. tag:cardio or is:suspended"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-400 focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          Search
        </button>
      </form>

      {error && (
        <p className="mb-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>
      )}

      {inDetail ? (
        <div>
          {/* Detail navigation: back to list + prev/next card */}
          <div className="mb-3 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={backToList}
              className="text-sm font-medium text-sky-700 hover:text-sky-800 hover:underline"
            >
              ← Back to list
            </button>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-slate-400">
                Card {(selectedIndex ?? 0) + 1} of {total}
              </span>
              <button
                type="button"
                onClick={() => setSelectedIndex((i) => (i != null ? i - 1 : i))}
                disabled={(selectedIndex ?? 0) <= 0 || detailLoading}
                className="rounded-lg border border-slate-300 px-3 py-1 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                Prev
              </button>
              <button
                type="button"
                onClick={() => setSelectedIndex((i) => (i != null ? i + 1 : i))}
                disabled={(selectedIndex ?? 0) >= total - 1 || detailLoading}
                className="rounded-lg border border-slate-300 px-3 py-1 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>

          {detail && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-slate-400">Tags:</span>
              <TagChips tags={detail.tags} />
              <span className="ml-auto text-xs text-slate-400">{detail.modelName}</span>
            </div>
          )}

          {detailLoading && !detail && (
            <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">Loading card…</p>
          )}

          {detail && (
            <div className={`space-y-3 ${detailLoading ? 'opacity-50' : ''}`}>
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Front
                </div>
                <CardFrame title="Card front" doc={frontDoc} />
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Back
                </div>
                <CardFrame title="Card back" doc={backDoc} />
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          {activeLabel && (
            <div className="mb-2 flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-slate-600" title={activeLabel}>
                {activeLabel}
              </span>
              {cardIds && (
                <span className="shrink-0 text-slate-400">
                  {total} card{total === 1 ? '' : 's'}
                </span>
              )}
            </div>
          )}

          {loading && !items && (
            <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">Loading cards…</p>
          )}

          {!loading && cardIds && total === 0 && (
            <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">
              No cards match. Try another deck or search.
            </p>
          )}

          {!activeLabel && !loading && (
            <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-400">
              Pick a deck or type a search to begin.
            </p>
          )}

          {items && total > 0 && (
            <>
              <ul className="divide-y divide-slate-100">
                {items.map((it, i) => (
                  <li key={it.cardId}>
                    <button
                      type="button"
                      onClick={() => setSelectedIndex(page * PAGE_SIZE + i)}
                      className="flex w-full items-start gap-3 py-2.5 text-left hover:bg-slate-50"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-sky-700">
                          {it.preview || (
                            <span className="italic text-slate-400">(empty)</span>
                          )}
                        </span>
                        <span className="mt-1 block">
                          <TagChips tags={it.tags} />
                        </span>
                      </span>
                      <span className="mt-1 shrink-0 text-xs text-slate-300">›</span>
                    </button>
                  </li>
                ))}
              </ul>

              {total > PAGE_SIZE && (
                <div className="mt-3 flex items-center justify-between text-sm">
                  <span className="text-slate-400">
                    Showing {from}–{to} of {total}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => cardIds && void loadPage(cardIds, page - 1)}
                      disabled={page === 0 || loading}
                      className="rounded-lg border border-slate-300 px-3 py-1 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      onClick={() => cardIds && void loadPage(cardIds, page + 1)}
                      disabled={page >= lastPage || loading}
                      className="rounded-lg border border-slate-300 px-3 py-1 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
