// Helpers to build & escape Anki search queries.
//
// Anki search syntax we use: deck:"Name::Sub", tag:"x", is:suspended.
// Deck and tag names can contain spaces, "::", quotes, or unicode, so every
// value must be quoted and any embedded double-quotes escaped with a backslash.

function quote(value: string): string {
  // Escape backslashes first, then double-quotes, then wrap in quotes.
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Search query matching all cards in a deck (including its subdecks). */
export function deckQuery(deckName: string): string {
  return `deck:${quote(deckName)}`;
}

/** Search query matching all cards with a given tag. */
export function tagQuery(tag: string): string {
  return `tag:${quote(tag)}`;
}

export type TargetKind = 'deck' | 'tag';

/** Build the query for the suspend manager's current selection. */
export function targetQuery(kind: TargetKind, value: string): string {
  return kind === 'deck' ? deckQuery(value) : tagQuery(value);
}

/** Cards that are currently suspended (optionally narrowed by another query). */
export function suspendedQuery(scope?: string): string {
  return scope ? `(${scope}) is:suspended` : 'is:suspended';
}
