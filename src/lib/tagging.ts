import { addTags, findNotes, getTags, removeTags } from './anki';

export const NEEDS_REVIEW = '__needs_review__';

/** A persisted record of one apply run, enough to undo it exactly. */
export interface TaggingRun {
  id: string;
  ts: number;
  deck: string;
  prefix: string;
  /** noteId -> full namespaced tags applied in this run. */
  applied: Record<number, string[]>;
  noteCount: number;
  tagCount: number;
}

const RUNS_KEY = 'deckpilot.tagRuns';

export function loadRuns(): TaggingRun[] {
  try {
    const raw = localStorage.getItem(RUNS_KEY);
    return raw ? (JSON.parse(raw) as TaggingRun[]) : [];
  } catch {
    return [];
  }
}

function persist(runs: TaggingRun[]): void {
  try {
    localStorage.setItem(RUNS_KEY, JSON.stringify(runs));
  } catch {
    /* ignore quota / unavailable */
  }
}

/** Prefix a taxonomy tag with the namespace, e.g. "ai::" + "cardio::pharm". */
export function namespaced(prefix: string, tag: string): string {
  const p = prefix.endsWith('::') ? prefix : `${prefix}::`;
  return `${p}${tag}`;
}

/**
 * Apply approved proposals. Writes are grouped by tag (so one addTags call per
 * unique tag rather than per note), batched, and reversible. Off-taxonomy tags
 * and the needs-review sentinel are never written. Returns the saved run.
 */
export async function applyTags(
  deck: string,
  prefix: string,
  proposals: Record<number, string[]>,
  taxonomy: string[],
  opts: { onProgress?: (done: number, total: number) => void; chunk?: number } = {}
): Promise<TaggingRun> {
  const allowed = new Set(taxonomy);
  const chunk = opts.chunk ?? 200;

  // Invert to fullTag -> noteIds, validating against the taxonomy.
  const notesByTag = new Map<string, number[]>();
  const applied: Record<number, string[]> = {};
  for (const [idStr, tags] of Object.entries(proposals)) {
    const id = Number(idStr);
    for (const t of tags) {
      if (t === NEEDS_REVIEW || !allowed.has(t)) continue;
      const full = namespaced(prefix, t);
      (notesByTag.get(full) ?? notesByTag.set(full, []).get(full)!).push(id);
      (applied[id] ??= []).push(full);
    }
  }

  const tagEntries = [...notesByTag.entries()];
  const total = tagEntries.reduce((n, [, ids]) => n + Math.ceil(ids.length / chunk), 0);
  let done = 0;

  for (const [fullTag, ids] of tagEntries) {
    for (let i = 0; i < ids.length; i += chunk) {
      await addTags(ids.slice(i, i + chunk), fullTag);
      done += 1;
      opts.onProgress?.(done, total);
    }
  }

  const run: TaggingRun = {
    id: `run_${Date.now().toString(36)}`,
    ts: Date.now(),
    deck,
    prefix,
    applied,
    noteCount: Object.keys(applied).length,
    tagCount: tagEntries.length,
  };
  const runs = loadRuns();
  runs.unshift(run);
  persist(runs);
  return run;
}

/** Undo a run: remove exactly the tags it added, then drop it from the log. */
export async function undoRun(runId: string, chunk = 200): Promise<void> {
  const runs = loadRuns();
  const run = runs.find((r) => r.id === runId);
  if (!run) return;

  // Invert applied map to tag -> noteIds for efficient removeTags calls.
  const notesByTag = new Map<string, number[]>();
  for (const [idStr, tags] of Object.entries(run.applied)) {
    for (const t of tags) (notesByTag.get(t) ?? notesByTag.set(t, []).get(t)!).push(Number(idStr));
  }
  for (const [tag, ids] of notesByTag) {
    for (let i = 0; i < ids.length; i += chunk) {
      await removeTags(ids.slice(i, i + chunk), tag);
    }
  }
  persist(runs.filter((r) => r.id !== runId));
}

/** Escape hatch: strip every tag under the prefix from the whole collection. */
export async function removeAllPrefixed(prefix: string): Promise<number> {
  const root = prefix.replace(/::$/, '');
  const notes = await findNotes(`tag:${root}::*`);
  const all = await getTags();
  const toRemove = all.filter((t) => t === root || t.startsWith(`${root}::`));
  if (notes.length && toRemove.length) {
    for (let i = 0; i < notes.length; i += 200) {
      await removeTags(notes.slice(i, i + 200), toRemove.join(' '));
    }
  }
  return notes.length;
}
