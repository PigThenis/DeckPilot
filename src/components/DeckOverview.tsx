import { useCallback, useEffect, useState } from 'react';
import { deckNamesAndIds, getDeckStats, type DeckStat } from '../lib/anki';

interface DeckOverviewProps {
  /** Changes whenever a fresh connection is established — triggers a refetch. */
  connectedAt: number | null;
  /** Reports the collection-wide due total upward for the analytics heuristic. */
  onTotals?: (totals: { dueToday: number }) => void;
  /** Called with a deck's full name when its label is clicked (opens Card View). */
  onSelectDeck?: (fullName: string) => void;
}

// A deck name like "Step1::Cardio::ECG" describes a position in a tree, with
// "::" as the separator. We rebuild that tree so the UI can nest and collapse it.
interface DeckNode {
  name: string; // full name, e.g. "Step1::Cardio"
  label: string; // last segment, e.g. "Cardio"
  stat?: DeckStat;
  children: DeckNode[];
}

function buildTree(decks: DeckStat[]): DeckNode[] {
  const byName = new Map<string, DeckNode>();
  const statByName = new Map(decks.map((d) => [d.name, d]));
  const roots: DeckNode[] = [];

  // Create a node (and any missing ancestors) for a full deck name.
  function ensure(fullName: string): DeckNode {
    const existing = byName.get(fullName);
    if (existing) return existing;
    const segments = fullName.split('::');
    const node: DeckNode = {
      name: fullName,
      label: segments[segments.length - 1],
      stat: statByName.get(fullName),
      children: [],
    };
    byName.set(fullName, node);
    if (segments.length === 1) {
      roots.push(node);
    } else {
      ensure(segments.slice(0, -1).join('::')).children.push(node);
    }
    return node;
  }

  for (const d of decks) ensure(d.name);

  const sortRec = (nodes: DeckNode[]) => {
    nodes.sort((a, b) => a.label.localeCompare(b.label));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

/** Full names of every node that has children (i.e. is collapsible). */
function parentNames(nodes: DeckNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.children.length) out.push(n.name);
    parentNames(n.children, out);
  }
  return out;
}

function Num({ value, color }: { value: number; color: string }) {
  return (
    <span className={`w-12 text-right text-sm font-semibold tabular-nums ${color}`}>
      {value || <span className="text-slate-300">0</span>}
    </span>
  );
}

function DeckRows({
  nodes,
  depth,
  collapsed,
  toggle,
  onSelectDeck,
}: {
  nodes: DeckNode[];
  depth: number;
  collapsed: Set<string>;
  toggle: (name: string) => void;
  onSelectDeck?: (fullName: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isCollapsed = collapsed.has(node.name);
        const s = node.stat;
        return (
          <div key={node.name}>
            <div className="flex items-center gap-4 border-b border-slate-100 py-2.5">
              <div
                className="flex min-w-0 flex-1 items-center"
                style={{ paddingLeft: depth * 18 }}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    onClick={() => toggle(node.name)}
                    className="mr-1 flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                  >
                    <span
                      className={`inline-block transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                    >
                      ▸
                    </span>
                  </button>
                ) : (
                  <span className="mr-1 inline-block w-5" />
                )}
                <button
                  type="button"
                  onClick={() => onSelectDeck?.(node.name)}
                  title={`Browse ${node.name}`}
                  className={`truncate text-left text-sm text-sky-700 hover:text-sky-800 hover:underline ${
                    hasChildren ? 'font-semibold' : 'font-medium'
                  }`}
                >
                  {node.label}
                </button>
              </div>
              <div className="flex shrink-0 gap-4">
                <Num value={s?.new_count ?? 0} color="text-sky-600" />
                <Num value={s?.learn_count ?? 0} color="text-orange-600" />
                <Num value={s?.review_count ?? 0} color="text-emerald-600" />
              </div>
            </div>
            {hasChildren && !isCollapsed && (
              <DeckRows
                nodes={node.children}
                depth={depth + 1}
                collapsed={collapsed}
                toggle={toggle}
                onSelectDeck={onSelectDeck}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/** Panel B — plain-English "where do I stand" deck overview, nested by hierarchy. */
export default function DeckOverview({
  connectedAt,
  onTotals,
  onSelectDeck,
}: DeckOverviewProps) {
  const [tree, setTree] = useState<DeckNode[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nameToId = await deckNamesAndIds();
      const names = Object.keys(nameToId);
      const statsById = await getDeckStats(names);
      // getDeckStats reports each deck's LEAF name only (e.g. "EPC Exam 1"), so
      // we can't build the hierarchy from it. Take the full "Parent::Child" paths
      // from deckNamesAndIds and attach each deck's stats by id.
      const list: DeckStat[] = names.map((fullName) => {
        const s = statsById[String(nameToId[fullName])];
        return {
          deck_id: nameToId[fullName],
          name: fullName,
          new_count: s?.new_count ?? 0,
          learn_count: s?.learn_count ?? 0,
          review_count: s?.review_count ?? 0,
          total_in_deck: s?.total_in_deck ?? 0,
        };
      });
      const roots = buildTree(list);
      setTree(roots);
      // Collapse all sub-levels by default for a clean, scannable overview.
      setCollapsed(new Set(parentNames(roots)));

      // Sum ONLY the top-level decks: getDeckStats already rolls subdeck counts
      // into their parent, so summing every deck would double-count.
      const dueToday = roots.reduce(
        (sum, r) => sum + (r.stat?.learn_count ?? 0) + (r.stat?.review_count ?? 0),
        0
      );
      onTotals?.({ dueToday });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [onTotals]);

  useEffect(() => {
    if (connectedAt != null) void load();
  }, [connectedAt, load]);

  const toggle = useCallback((name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const allParents = tree ? parentNames(tree) : [];
  const anyCollapsible = allParents.length > 0;
  const allCollapsed = anyCollapsible && allParents.every((n) => collapsed.has(n));

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Where do I stand?</h2>
          <p className="text-sm text-slate-500">Your decks and what's waiting in each.</p>
        </div>
        <div className="flex items-center gap-3">
          {loading && <span className="text-xs text-slate-400">Loading…</span>}
          {anyCollapsible && (
            <button
              type="button"
              onClick={() =>
                setCollapsed(allCollapsed ? new Set() : new Set(allParents))
              }
              className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          )}
        </div>
      </div>

      {error && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}

      {!error && tree && tree.length === 0 && (
        <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">
          No decks found. Create a deck in Anki and click Retry.
        </p>
      )}

      {!error && tree && tree.length > 0 && (
        <div>
          {/* Column headers */}
          <div className="flex items-center gap-4 border-b border-slate-200 pb-1.5">
            <span className="flex-1 text-xs uppercase tracking-wide text-slate-400">Deck</span>
            <div className="flex shrink-0 gap-4">
              <span className="w-12 text-right text-xs uppercase tracking-wide text-sky-500">New</span>
              <span className="w-12 text-right text-xs uppercase tracking-wide text-orange-500">Learn</span>
              <span className="w-12 text-right text-xs uppercase tracking-wide text-emerald-500">Due</span>
            </div>
          </div>
          <DeckRows
            nodes={tree}
            depth={0}
            collapsed={collapsed}
            toggle={toggle}
            onSelectDeck={onSelectDeck}
          />
        </div>
      )}

      {!error && !tree && !loading && (
        <p className="text-sm text-slate-400">Connect to Anki to see your decks.</p>
      )}
    </section>
  );
}
