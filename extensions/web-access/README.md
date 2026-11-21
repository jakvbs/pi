# Web Access

Web search, page fetching and stored-result retrieval for pi: three tools, no commands or UI.
It replaces the copy of [pi-web-access](https://github.com/nicobailon/pi-web-access) this fork carried, keeping the tool names, the arguments sessions use and the stored session entries; `UPSTREAM` records the last reviewed upstream commit as a reference only.

## Tools

### web_search

Searches with OpenAI hosted search or Exa and stores the results under a `responseId`.

| Argument | Meaning |
| --- | --- |
| `queries` / `query` | Queries to run, up to three at a time. A `query` holding a JSON array is split. |
| `numResults` | Sources per query, default 5. |
| `provider` | `auto` (default, follows `searchRouting`), `openai`, `exa`, or `all` (every provider, merged). |
| `domainFilter` | Domains to keep; a `-` prefix excludes one. |
| `recencyFilter` | `day`, `week`, `month` or `year`. |
| `includeContent` | Also fetch every result page (readable mode) and store it under a separate `fetchId`. |

OpenAI search uses pi's own login: the ChatGPT subscription (`openai-codex`, sent to the Codex backend) or an `openai` API key for `api.openai.com`. It runs the newest low-cost model of that provider with the `web_search` tool required. Exa uses its keyless MCP endpoint (`mcp.exa.ai`); filtered searches use `web_search_advanced_exa` and fall back to `web_search_exa`.

`provider: "auto"` reads `searchRouting` from `~/.pi/agent/web-search.json`:

```json
{ "searchRouting": { "providers": ["openai", "exa"], "fallbackOn": ["unsupported", "transient", "quota", "network", "invalid-response"] } }
```

Providers are tried in order. A provider that is not logged in is skipped; a failure moves on only when its kind is listed in `fallbackOn` (`unsupported`, `transient`, `quota`, `network`, `invalid-response`, `auth`, `invalid-request`, `empty`, `unknown`). The values above are the defaults.

### fetch_content

Fetches `url`, or `urls` in parallel, and stores the full content under a `responseId`.

- `mode: "readable"` (default) asks for Markdown, converts HTML with Readability and Turndown, and turns PDFs (up to 100 pages, 20 MB) into Markdown saved under `$TMPDIR/pi-web-pdf/`.
- `mode: "raw"` returns the exact textual body.
- `mode: "answer"` with `prompt` has the session's current model answer the question from each page, marked as untrusted data, and returns only the answers; a `prompt` alone implies this mode.

GitHub repository, tree and blob URLs are shallow-cloned (repositories up to 350 MB) into `$TMPDIR/pi-web-access-clones/` and shown as a file tree with the README, a directory listing or the file, with the clone path for `read` and `bash`. Larger repositories, commit-SHA URLs and failed clones use a `gh api` view. Issues, pull requests and other GitHub pages are fetched as ordinary pages.

### get_search_content

Reads stored results by `responseId`: `queryIndex` for searches, `urlIndex` for fetches, `offset` and `limit` to page, `findText` (one string or up to ten) with `findMode` `case-insensitive` (default) or `exact` to get matching passages with context instead. Without an index, a result with several entries is listed, or searched as a whole with `findText`.

## Limits and safety

- Tool output stays within 30,000 characters; the rest is paged with `get_search_content`.
- Fetches go only to public HTTP(S) addresses: every hostname is resolved and refused when any address is loopback, private, link-local, CGNAT, multicast, reserved or IPv4-mapped internal, and every redirect (at most 5) is checked again. Text responses are capped at 5 MB.
- Results are appended to the session as `web-search-results` entries, so resumed sessions can read them. Fetch entries keep only page metadata; the text lives in `~/.pi/agent/web-search-cache/` for one hour (at most 128 files and 128 MiB, owner-only permissions). Entries written by the earlier extension restore unchanged.

## Development

```sh
npm ci                 # runtime dependencies; pi does not install them for path-loaded packages
npm run typecheck
npm test
```
