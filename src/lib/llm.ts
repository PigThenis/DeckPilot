import type { CleanCard } from './clean';

/**
 * Provider-agnostic model interface. The UI talks only to this; swap the
 * implementation to change providers without touching the flow.
 */
export interface LlmClient {
  /** Propose a flat, hierarchical tag vocabulary for a deck from a sample. */
  proposeTaxonomy(sample: CleanCard[]): Promise<string[]>;
  /** Classify a batch of cards into the fixed taxonomy. Returns noteId -> tags. */
  classify(cards: CleanCard[], taxonomy: string[]): Promise<Record<number, string[]>>;
}

export const DEFAULT_MODEL =
  (import.meta.env.VITE_OPENAI_MODEL as string | undefined) ?? 'gpt-5.4-nano-2026-03-17';

export function hasApiKey(): boolean {
  return Boolean((import.meta.env.VITE_OPENAI_API_KEY as string | undefined)?.trim());
}

/** Strip code fences and parse JSON defensively. */
function parseJson(content: string): unknown {
  let s = content.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(s);
}

function normalizeTag(t: string): string {
  return t
    .trim()
    .replace(/^#+/, '')
    .replace(/\s*::\s*/g, '::')
    .replace(/\s+/g, '-')
    .replace(/^::+|::+$/g, '');
}

// ---------------------------------------------------------------------------
// OpenAI implementation (via the /openai dev proxy; key from .env).
// ---------------------------------------------------------------------------

class OpenAiClient implements LlmClient {
  private readonly key: string;
  private readonly model: string;

  constructor() {
    this.key = (import.meta.env.VITE_OPENAI_API_KEY as string | undefined)?.trim() ?? '';
    this.model = DEFAULT_MODEL;
  }

  private async chat(system: string, user: string): Promise<unknown> {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    };
    const send = async () => {
      const res = await fetch('/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.key}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`OpenAI ${res.status}: ${t.slice(0, 300)}`);
      }
      const data = await res.json();
      const content: string = data?.choices?.[0]?.message?.content ?? '';
      return parseJson(content);
    };
    // Retry once on malformed JSON; let HTTP errors bubble for the caller.
    try {
      return await send();
    } catch (e) {
      if (e instanceof SyntaxError) return await send();
      throw e;
    }
  }

  async proposeTaxonomy(sample: CleanCard[]): Promise<string[]> {
    const system =
      'You organize flashcard decks into a clean tag taxonomy. Infer the deck\'s ACTUAL ' +
      'topics from the sample cards and propose tags that reflect THIS deck\'s content — not ' +
      'generic categories you assume. Tags are lowercase, words joined by hyphens, with ' +
      'optional one-level nesting via "::" (e.g. "history-taking::chief-complaint", ' +
      '"physical-exam", "ethics"). Group related cards under shared parents; keep 8–25 tags; ' +
      'avoid near-duplicates and one-off tags. Every tag must correspond to themes you ' +
      'actually observe. Respond ONLY as JSON: {"tags": ["a", "a::b", ...]}.';
    const user =
      'Sample cards (one per line). Derive the taxonomy from what these are actually about:\n' +
      sample.map((c) => `- ${c.text.slice(0, 500)}`).join('\n');
    const out = await this.chat(system, user);
    const tags = (out as { tags?: unknown }).tags;
    if (!Array.isArray(tags)) return [];
    return [...new Set(tags.map((t) => normalizeTag(String(t))).filter(Boolean))];
  }

  async classify(cards: CleanCard[], taxonomy: string[]): Promise<Record<number, string[]>> {
    const allowed = new Set(taxonomy);
    const system =
      'You assign flashcards to tags based on each card\'s actual content. Choose the most ' +
      'relevant tag(s) ONLY from the provided list; a card may get several. Judge by what the ' +
      'card is about (e.g. a card defining "chief complaint" is history-taking terminology, ' +
      'not anatomy). If a card does not clearly fit any listed tag, return "__needs_review__" ' +
      'rather than forcing a wrong one. Never invent tags. ' +
      'Respond ONLY as JSON: {"results":[{"id":<noteId>,"tags":["..."]}]}.';
    const user =
      `Allowed tags:\n${taxonomy.join('\n')}\n\nClassify these cards by their content:\n` +
      cards.map((c) => `id ${c.noteId}: ${c.text.slice(0, 600)}`).join('\n');
    const out = await this.chat(system, user);
    const results = (out as { results?: unknown }).results;
    const map: Record<number, string[]> = {};
    if (Array.isArray(results)) {
      for (const r of results) {
        const id = Number((r as { id?: unknown }).id);
        const tags = (r as { tags?: unknown }).tags;
        if (!Number.isFinite(id) || !Array.isArray(tags)) continue;
        // Enforce the controlled vocabulary: drop anything off-list.
        const valid = tags.map((t) => normalizeTag(String(t))).filter((t) => allowed.has(t));
        map[id] = valid;
      }
    }
    return map;
  }
}

// ---------------------------------------------------------------------------
// Demo implementation — zero API cost, exercises the full flow with canned data.
// ---------------------------------------------------------------------------

class DemoClient implements LlmClient {
  async proposeTaxonomy(): Promise<string[]> {
    await delay(400);
    return [
      'anatomy::gross',
      'anatomy::neuro',
      'physiology::cardio',
      'physiology::renal',
      'physiology::respiratory',
      'pharmacology::autonomic',
      'biochem::metabolism',
      'histology',
    ];
  }

  async classify(cards: CleanCard[], taxonomy: string[]): Promise<Record<number, string[]>> {
    await delay(300);
    const map: Record<number, string[]> = {};
    for (const c of cards) {
      const t = c.text.toLowerCase();
      const picks = taxonomy.filter((tag) => {
        const key = tag.split('::').pop() ?? tag;
        return t.includes(key.slice(0, 4));
      });
      // Deterministic fallback so every card gets something to review.
      map[c.noteId] = picks.length
        ? picks.slice(0, 2)
        : [taxonomy[c.noteId % taxonomy.length] ?? '__needs_review__'];
    }
    return map;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function getClient(demo: boolean): LlmClient {
  return demo ? new DemoClient() : new OpenAiClient();
}
