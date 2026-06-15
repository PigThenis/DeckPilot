import { useCallback, useEffect, useState } from 'react';
import { findCards, getNumCardsReviewedToday } from '../lib/anki';

interface AnalyticsProps {
  connectedAt: number | null;
  /** Collection-wide cards due today, reported up from the deck overview. */
  dueToday: number | null;
}

function Metric({ value, label, hint }: { value: number; label: string; hint?: string }) {
  return (
    <div className="flex-1 rounded-xl bg-slate-50 p-4 text-center">
      <div className="text-3xl font-bold tabular-nums text-slate-900">{value}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

/** Panel D — small, motivational "am I keeping up?" readout. */
export default function Analytics({ connectedAt, dueToday }: AnalyticsProps) {
  const [reviewedToday, setReviewedToday] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [suspended, setSuspended] = useState<number | null>(null);
  const [newWaiting, setNewWaiting] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [reviewed, allIds, suspendedIds, newIds] = await Promise.all([
        getNumCardsReviewedToday(),
        findCards('deck:*'),
        findCards('is:suspended'),
        findCards('is:new -is:suspended'),
      ]);
      setReviewedToday(reviewed);
      setSuspended(suspendedIds.length);
      setActive(Math.max(0, allIds.length - suspendedIds.length));
      setNewWaiting(newIds.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connectedAt != null) void load();
  }, [connectedAt, load]);

  // Keeping-up heuristic: have today's reviews covered what was due? "Due" only
  // exists for cards reviewed at least once, so for a fresh deck we instead point
  // the user at the new cards waiting to be learned.
  let verdict: { text: string; tone: string } | null = null;
  if (reviewedToday != null && dueToday != null) {
    if (dueToday > 0 && reviewedToday < dueToday) {
      const left = dueToday - reviewedToday;
      verdict = {
        text: `About ${left} card${left === 1 ? '' : 's'} still due today. A short session keeps you on track.`,
        tone: 'amber',
      };
    } else if (dueToday > 0) {
      verdict = { text: "You're keeping up — today's reviews are covered. 👍", tone: 'emerald' };
    } else if (reviewedToday > 0) {
      verdict = {
        text: `Nice — ${reviewedToday} reviewed and nothing left due today. 🎉`,
        tone: 'emerald',
      };
    } else if (newWaiting && newWaiting > 0) {
      verdict = {
        text: `Nothing scheduled yet. You have ${newWaiting} new card${newWaiting === 1 ? '' : 's'} ready — start a session in Anki to begin learning them.`,
        tone: 'sky',
      };
    } else {
      verdict = { text: "All caught up — nothing due right now. 🎉", tone: 'emerald' };
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Am I keeping up?</h2>
          <p className="text-sm text-slate-500">A quick pulse on your collection.</p>
        </div>
        {loading && <span className="text-xs text-slate-400">Loading…</span>}
      </div>

      {error && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}

      {!error && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric value={reviewedToday ?? 0} label="Reviewed today" />
            <Metric value={newWaiting ?? 0} label="New waiting" />
            <Metric value={active ?? 0} label="Active cards" />
            <Metric value={suspended ?? 0} label="Suspended" />
          </div>

          {verdict && (
            <p
              className={`mt-4 rounded-xl p-3 text-sm font-medium ${
                verdict.tone === 'amber'
                  ? 'bg-amber-50 text-amber-800'
                  : verdict.tone === 'sky'
                    ? 'bg-sky-50 text-sky-800'
                    : 'bg-emerald-50 text-emerald-800'
              }`}
            >
              {verdict.text}
            </p>
          )}
        </>
      )}
    </section>
  );
}
