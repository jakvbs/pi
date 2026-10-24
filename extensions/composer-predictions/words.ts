/** Letters and digits, with an apostrophe or hyphen allowed between them. Underscores split identifiers. */
export const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const TRAILING_WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*$/u;
/** Context of the first words of a prompt. No word is empty, so it cannot collide. */
const START = "";
/** Weights of the evidence after two words, after one word, and of the word alone. Missing evidence passes its weight on. */
const WEIGHTS = [0.4, 0.3, 0.2] as const;
/** Half the words in the author's history appear once: typos, hashes, pasted ids. A word becomes a ghost from its second use. */
const MIN_SEEN = 2;
/** Hashes, UUIDs, tokens and keys: a run of 12 letters or digits that holds a digit. Never shown, however often seen. */
const RANDOM_PART = /(?=[\p{L}\p{N}]*\d)[\p{L}\p{N}]{12,}/u;
/** A UUID whose 12-character group happens to hold no digit escapes `RANDOM_PART`. */
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

interface Tally {
	total: number;
	readonly counts: Map<string, number>;
}

export interface Completion {
	readonly word: string;
	/** The word's share of the probability of every word under the prefix, the prefix itself included. */
	readonly confidence: number;
}

export interface Ghost {
	/** Where the completed word starts in the draft. */
	readonly start: number;
	readonly rest: string;
	readonly confidence: number;
}

export function wordsOf(text: string): string[] {
	return Array.from(text.toLowerCase().matchAll(WORD), (match) => match[0]);
}

function count(tally: Tally, word: string): void {
	tally.total++;
	tally.counts.set(word, (tally.counts.get(word) ?? 0) + 1);
}

function tallyOf(tallies: Map<string, Tally>, key: string): Tally {
	let tally = tallies.get(key);
	if (!tally) {
		tally = { total: 0, counts: new Map() };
		tallies.set(key, tally);
	}
	return tally;
}

function lowerBound(sorted: readonly string[], value: string): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (sorted[mid]! < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Interpolated word trigram counts over the user's prompts. */
export class WordModel {
	/** Every learned word in code-unit order, so the words under a prefix are one index range. */
	private readonly words: string[] = [];
	private sorted = true;
	private readonly unigram: Tally = { total: 0, counts: new Map() };
	private readonly random = new Set<string>();
	private readonly afterOne = new Map<string, Tally>();
	private readonly afterTwo = new Map<string, Tally>();

	get size(): number {
		return this.words.length;
	}

	learn(text: string): void {
		let second = START;
		let first = START;
		for (const word of wordsOf(text)) {
			if (!this.unigram.counts.has(word)) {
				this.words.push(word);
				this.sorted = false;
				if (RANDOM_PART.test(word) || UUID.test(word)) this.random.add(word);
			}
			count(this.unigram, word);
			count(tallyOf(this.afterOne, first), word);
			count(tallyOf(this.afterTwo, `${second} ${first}`), word);
			second = first;
			first = word;
		}
	}

	private suggestible(word: string, seen: number): boolean {
		return seen >= MIN_SEEN && !this.random.has(word);
	}

	/**
	 * Sorts the words learned since the last call into the prefix index. `complete` does it when needed. A long load
	 * calls it now and then, so each sort merges the newest words into sorted ones instead of ordering all at once.
	 */
	index(): void {
		if (this.sorted) return;
		this.words.sort();
		this.sorted = true;
	}

	/**
	 * The likeliest suggestible word starting with the lowercase `prefix` after the last two words before it, oldest
	 * first. Unsuggestible words still take their share of the probability, so they lower the confidence.
	 */
	complete(previous: readonly [string, string], prefix: string): Completion | undefined {
		this.index();
		const lo = lowerBound(this.words, prefix);
		const hi = prefix ? lowerBound(this.words, `${prefix}\uffff`) : this.words.length;
		if (lo === hi) return undefined;
		const contexts = [this.afterTwo.get(`${previous[0]} ${previous[1]}`), this.afterOne.get(previous[1])];
		const tallies = [...contexts, this.unigram];
		const norm = WEIGHTS.reduce((sum, weight, index) => (tallies[index] ? sum + weight : sum), 0);
		const shares = tallies.map((tally, index) => (tally ? WEIGHTS[index]! / norm / tally.total : 0));
		const score = (word: string) =>
			tallies.reduce((sum, tally, index) => sum + shares[index]! * (tally?.counts.get(word) ?? 0), 0);

		// Only a word seen after the context can outscore the most frequent suggestible word under the prefix.
		const candidates = new Set<string>();
		let mass = 0;
		for (const [index, tally] of contexts.entries()) {
			for (const [word, seen] of tally?.counts ?? []) {
				if (!word.startsWith(prefix)) continue;
				mass += shares[index]! * seen;
				if (this.suggestible(word, this.unigram.counts.get(word)!)) candidates.add(word);
			}
		}
		let top: string | undefined;
		let topSeen = 0;
		let rangeSeen = 0;
		for (let index = lo; index < hi; index++) {
			const word = this.words[index]!;
			const seen = this.unigram.counts.get(word)!;
			rangeSeen += seen;
			if (seen > topSeen && this.suggestible(word, seen)) {
				top = word;
				topSeen = seen;
			}
		}
		mass += shares[2]! * rangeSeen;
		if (top) candidates.add(top);

		let best: Completion | undefined;
		for (const word of candidates) {
			const confidence = score(word) / mass;
			if (!best || confidence > best.confidence) best = { word, confidence };
		}
		return best;
	}
}

/**
 * The rest of the word the draft ends in, or the next word after a space or in an empty draft.
 * Nothing while the draft ends in punctuation or the likeliest word is the one already typed.
 */
export function suggest(model: WordModel, draft: string): Ghost | undefined {
	const typed = TRAILING_WORD.exec(draft)?.[0] ?? "";
	const before = draft.slice(0, draft.length - typed.length);
	if (!typed && before !== "" && !before.endsWith(" ")) return undefined;
	const words = wordsOf(before);
	const prefix = typed.toLowerCase();
	const completion = model.complete([words.at(-2) ?? START, words.at(-1) ?? START], prefix);
	if (!completion || completion.word === prefix) return undefined;
	const rest = completion.word.slice(prefix.length);
	const shouted = typed.length > 1 && typed !== prefix && typed === typed.toUpperCase();
	return { start: before.length, rest: shouted ? rest.toUpperCase() : rest, confidence: completion.confidence };
}
