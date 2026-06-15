import type { NoteInfo } from './anki';

/** A note reduced to plain text, ready to send to a model. */
export interface CleanCard {
  noteId: number;
  text: string;
}

/**
 * Convert a card field's HTML into clean plain text for the model:
 * unwrap cloze deletions, strip tags and media refs, decode entities, collapse
 * whitespace. Uses a detached <textarea> for entity decoding so nothing loads.
 */
export function cleanText(html: string): string {
  let s = html;
  // {{c1::answer::hint}} -> answer  (keep the hidden text; drop the hint)
  s = s.replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/gs, '$1');
  // drop media/sound refs
  s = s.replace(/\[sound:[^\]]*\]/gi, ' ');
  // strip HTML tags
  s = s.replace(/<[^>]*>/g, ' ');
  const ta = document.createElement('textarea');
  ta.innerHTML = s;
  return ta.value.replace(/\s+/g, ' ').trim();
}

/** Flatten a note's fields (in display order) into one clean-text blob. */
export function noteToClean(note: NoteInfo): CleanCard {
  const text = Object.values(note.fields)
    .sort((a, b) => a.order - b.order)
    .map((f) => cleanText(f.value))
    .filter(Boolean)
    .join(' — ');
  return { noteId: note.noteId, text };
}

/** Evenly spread a sample of up to `n` items across an array (deterministic). */
export function spreadSample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items.slice();
  const step = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]);
  return out;
}
