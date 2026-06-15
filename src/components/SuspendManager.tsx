import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deckNames,
  findCards,
  getTags,
  partitionSuspended,
  suspend,
  unsuspend,
} from '../lib/anki';
import { targetQuery, type TargetKind } from '../lib/queries';
import Combobox from './Combobox';
import ConfirmDialog from './ConfirmDialog';

interface Toast {
  message: string;
  /** Inverse action to run if the user clicks Undo. */
  undo: () => Promise<void>;
}

type Pending = { direction: 'suspend' | 'unsuspend'; ids: number[]; label: string } | null;

/** Panel C — bulk suspend / unsuspend by tag or deck. The core value. */
export default function SuspendManager({ connectedAt }: { connectedAt: number | null }) {
  const [kind, setKind] = useState<TargetKind>('tag');
  const [tags, setTags] = useState<string[]>([]);
  const [decks, setDecks] = useState<string[]>([]);
  const [value, setValue] = useState('');

  const [listError, setListError] = useState<string | null>(null);

  // Match results for the current selection, partitioned by suspended state.
  const [activeIds, setActiveIds] = useState<number[] | null>(null);
  const [suspendedIds, setSuspendedIds] = useState<number[] | null>(null);
  const [counting, setCounting] = useState(false);
  const [countError, setCountError] = useState<string | null>(null);

  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  // Load tag & deck pickers when a connection is established.
  useEffect(() => {
    if (connectedAt == null) return;
    let cancelled = false;
    (async () => {
      setListError(null);
      try {
        const [t, d] = await Promise.all([getTags(), deckNames()]);
        if (cancelled) return;
        setTags([...t].sort((a, b) => a.localeCompare(b)));
        setDecks([...d].sort((a, b) => a.localeCompare(b)));
      } catch (e) {
        if (!cancelled) setListError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectedAt]);

  const options = kind === 'tag' ? tags : decks;

  // Reset the chosen value when switching between tag/deck.
  useEffect(() => {
    setValue('');
    setActiveIds(null);
    setSuspendedIds(null);
    setCountError(null);
  }, [kind]);

  const runCount = useCallback(async () => {
    if (!value) return;
    setCounting(true);
    setCountError(null);
    setActiveIds(null);
    setSuspendedIds(null);
    try {
      const ids = await findCards(targetQuery(kind, value));
      const { active, suspended } = await partitionSuspended(ids);
      setActiveIds(active);
      setSuspendedIds(suspended);
    } catch (e) {
      setCountError(e instanceof Error ? e.message : String(e));
    } finally {
      setCounting(false);
    }
  }, [kind, value]);

  // Auto-count whenever a value is picked.
  useEffect(() => {
    if (value) void runCount();
  }, [value, runCount]);

  const loaded = activeIds != null && suspendedIds != null;
  const active = activeIds?.length ?? 0;
  const suspended = suspendedIds?.length ?? 0;
  const total = active + suspended;

  const targetLabel = useMemo(
    () => (value ? `${kind === 'tag' ? 'tag' : 'deck'} "${value}"` : ''),
    [kind, value]
  );

  function askSuspend() {
    if (!activeIds || active === 0) return;
    setPending({ direction: 'suspend', ids: activeIds, label: targetLabel });
  }
  function askUnsuspend() {
    if (!suspendedIds || suspended === 0) return;
    setPending({ direction: 'unsuspend', ids: suspendedIds, label: targetLabel });
  }

  async function applyPending() {
    if (!pending) return;
    setBusy(true);
    try {
      const { direction, ids, label } = pending;
      if (direction === 'suspend') {
        await suspend(ids);
        setToast({
          message: `Suspended ${ids.length} cards in ${label}.`,
          undo: async () => {
            await unsuspend(ids);
            setToast(null);
            await runCount();
          },
        });
      } else {
        await unsuspend(ids);
        setToast({
          message: `Unsuspended ${ids.length} cards in ${label}.`,
          undo: async () => {
            await suspend(ids);
            setToast(null);
            await runCount();
          },
        });
      }
      setPending(null);
      await runCount();
    } catch (e) {
      setCountError(e instanceof Error ? e.message : String(e));
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-slate-900">Turn cards on / off</h2>
        <p className="text-sm text-slate-500">
          Bulk-suspend or unsuspend every card in a tag or deck at once.
        </p>
      </div>

      {listError && (
        <p className="mb-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{listError}</p>
      )}

      {/* Tag / deck toggle */}
      <div className="mb-3 inline-flex rounded-lg bg-slate-100 p-1 text-sm">
        {(['tag', 'deck'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`rounded-md px-3 py-1.5 font-medium capitalize ${
              kind === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
            }`}
          >
            By {k}
          </button>
        ))}
      </div>

      {/* Picker */}
      <div className="mb-4">
        {options.length === 0 ? (
          <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500">
            No {kind}s found in your collection.
          </p>
        ) : (
          <Combobox
            options={options}
            value={value}
            onChange={setValue}
            placeholder={`Type to search ${kind}s…`}
          />
        )}
      </div>

      {/* Count + actions */}
      {value && (
        <div className="rounded-xl bg-slate-50 p-4">
          {counting && <p className="text-sm text-slate-500">Counting cards…</p>}
          {countError && <p className="text-sm text-rose-700">{countError}</p>}
          {!counting && !countError && loaded && (
            <>
              {total === 0 ? (
                <p className="text-sm text-slate-500">
                  No cards match {targetLabel}. Nothing to change.
                </p>
              ) : (
                <>
                  <p className="text-sm text-slate-700">
                    <span className="text-lg font-bold tabular-nums">{total}</span> cards
                    match — <span className="font-semibold tabular-nums">{active}</span>{' '}
                    active, <span className="font-semibold tabular-nums">{suspended}</span>{' '}
                    suspended.
                  </p>
                  <div className="mt-3 flex gap-3">
                    <button
                      type="button"
                      onClick={askSuspend}
                      disabled={active === 0 || busy}
                      className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-40"
                    >
                      Suspend {active} active
                    </button>
                    <button
                      type="button"
                      onClick={askUnsuspend}
                      disabled={suspended === 0 || busy}
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                    >
                      Unsuspend {suspended} suspended
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Success toast with undo */}
      {toast && (
        <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          <span>{toast.message}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void toast.undo()}
              className="rounded-md border border-emerald-300 px-3 py-1 font-medium hover:bg-emerald-100"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="rounded-md px-2 py-1 text-emerald-600 hover:bg-emerald-100"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pending != null}
        title={pending?.direction === 'suspend' ? 'Suspend cards?' : 'Unsuspend cards?'}
        body={
          pending && (
            <p>
              This will{' '}
              <span className="font-semibold">
                {pending.direction === 'suspend' ? 'suspend' : 'unsuspend'}
              </span>{' '}
              <span className="font-semibold tabular-nums">{pending.ids.length}</span> cards
              in {pending.label}. This changes your real Anki scheduling. You can undo it
              right after.
            </p>
          )
        }
        confirmLabel={pending?.direction === 'suspend' ? 'Suspend' : 'Unsuspend'}
        confirmClass={
          pending?.direction === 'suspend'
            ? 'bg-amber-600 hover:bg-amber-500'
            : 'bg-emerald-600 hover:bg-emerald-500'
        }
        busy={busy}
        onConfirm={() => void applyPending()}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}
