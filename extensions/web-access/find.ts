// findText for get_search_content: literal matches with surrounding context, merged and bounded.
export type FindMode = "exact" | "case-insensitive";

const CONTEXT_CHARS = 400;
const MAX_OUTPUT_CHARS = 20_000;

export interface FindResult {
	text: string;
	matchCount: number;
	returnedMatches: number;
}

interface Range {
	start: number;
	end: number;
	queries: Map<string, number>;
}

export function findText(text: string, queries: string[], mode: FindMode): FindResult {
	const wanted = [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
	const haystack = mode === "case-insensitive" ? text.toLocaleLowerCase() : text;
	const matches: Array<{ query: string; start: number; end: number }> = [];
	const counts = new Map<string, number>();
	for (const query of wanted) {
		const needle = mode === "case-insensitive" ? query.toLocaleLowerCase() : query;
		let count = 0;
		for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
			matches.push({ query, start: at, end: at + needle.length });
			count++;
		}
		counts.set(query, count);
	}
	matches.sort((left, right) => left.start - right.start);

	const ranges: Range[] = [];
	for (const match of matches) {
		const start = Math.max(0, match.start - CONTEXT_CHARS);
		const end = Math.min(text.length, match.end + CONTEXT_CHARS);
		const last = ranges.at(-1);
		if (last && start <= last.end) last.end = Math.max(last.end, end);
		else ranges.push({ start, end, queries: new Map() });
		const range = ranges.at(-1)!;
		range.queries.set(match.query, (range.queries.get(match.query) ?? 0) + 1);
	}

	const missing = wanted.filter((query) => counts.get(query) === 0).map((query) => `"${query}"`);
	const sections = [matches.length > 0 ? `Text matches (${mode})` : `Text matches (${mode}): no matches`];
	const footer = missing.length > 0 ? [`No matches: ${missing.join(", ")}`] : [];
	let length = sections[0].length + footer.join("\n\n").length + 100;
	let returnedMatches = 0;
	for (const [index, range] of ranges.entries()) {
		const labels = [...range.queries].map(([query, count]) => `"${query}" ×${count}`).join(", ");
		const snippet = `${range.start > 0 ? "…" : ""}${text.slice(range.start, range.end).replace(/\s+/g, " ").trim()}${range.end < text.length ? "…" : ""}`;
		const section = `${index + 1}. ${labels}\n${snippet}`;
		if (length + section.length + 2 > MAX_OUTPUT_CHARS) break;
		sections.push(section);
		length += section.length + 2;
		returnedMatches += [...range.queries.values()].reduce((total, count) => total + count, 0);
	}
	sections.push(...footer);
	if (returnedMatches < matches.length) sections.push(`Showing ${returnedMatches} of ${matches.length} matches.`);
	return { text: sections.join("\n\n"), matchCount: matches.length, returnedMatches };
}
