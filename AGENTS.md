# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- Before recommending a fix design, check how sibling implementations (other adapters, providers, commands) handle the same concern, and follow that pattern. If you deviate, say why.
- No `any` unless absolutely necessary.
- Never tell the members of a typed union apart with `in` (`"report" in entry`): make it a tagged union (a `kind` field) and switch on the tag. `in` is only for values of unknown type at a trust boundary (wire input, files, Node errors), for feature detection, and for stored or frozen wire formats that a version bump would have to change (say so in a comment).
- No runtime checks of values whose types TypeScript already guarantees (no `typeof`/`instanceof`/`Array.isArray`/shape guards on typed parameters, typed callback results or typed declarations). Validate only at decided trust boundaries (wire input, schema-checked arguments and params).
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- In `packages/coding-agent`, resolve package assets through helpers in `src/config.ts`. Do not use `__dirname` directly; the helpers account for source checkouts, npm installations, and standalone binaries.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update the catalog definitions in `packages/ai/catalog/` instead (see its README), then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes. The generated model data in `packages/ai/src/providers/data/` is gitignored: never stage it, and don't look for it in git history.

## Reviews

- When reviewers (subagents or other sessions) report while others are still reviewing, do not summarize or relay their findings piecemeal. Wait until every report is in, then give one report that covers all of them.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Run `npm run build` whenever something needs built output (`dist/`): tests or benchmarks that import built packages, and pi-web's typecheck and tests (`apps/web/AGENTS.md`). Never use it to type check or lint: that is `npm run check`, the preferred check.
- Never run `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. It runs `packages/*` only. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct registry deps, including internal workspace deps, stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install`; clean/CI-style with `npm ci`.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

Never force-push, reset or delete `main`. Run branches may be pushed, rewritten and force-pushed; Git authorization is in the global contract (`~/.pi/agent/AGENTS.md`).

If conflicts occur while rebasing your own branch (an upstream merge follows section Fork):

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.

## Fork

This checkout is the `jakvbs/pi` fork; its `main` on `origin` is the source of truth. Do not open issues or PRs against `earendil-works/pi` and do not propose upstreaming. Never rebase `main` onto `upstream/main`: the ruleset refuses the force-push it needs. Keep fork commits small and self-contained so the merge stays cheap.

Upstream changes arrive through an occasional merge into a run branch based on `main`:

1. `git fetch upstream && git merge --no-commit upstream/main`.
2. `node scripts/fork-deleted.mjs resolve`: `git rm`s what the merge brought back of the upstream paths the fork deleted (patterns in `fork-deleted.txt`), both modify/delete conflicts and new upstream files.
3. Resolve the remaining conflicts, run `npm run check` (`check:fork-deleted` fails while a deleted path is tracked) and the tests, commit, and deliver (section Delivery).

To delete an upstream path, delete it and add its pattern to `fork-deleted.txt` in the same commit. For apps/web and the imported extensions, add an `exclude` key to their `UPSTREAM` instead (`extensions/README.md`).

## Delivery

- `~/.local/bin/pi` runs this checkout's `main` from source for every pi session and background run on this machine, so a commit on `main` is a deployment. Land a change only after `npm run check` and the tests it touches have passed.
- Prepare a fresh worktree with `npm ci`, then `npm --prefix packages/ai run hydrate-model-data`: without the gitignored model data `npm run check` fails with type errors.
- Fast-forward `main` in `~/.repos/pi` to the verified branch (`git merge --ff-only <branch>`) and push with `git push origin main` (or open a PR with `gh pr create` + `gh pr merge --auto`). The ruleset on `main` blocks force-push and deletion; CI still runs on `main` after the push.
- Right after a change lands on `main`, run `pi --version` in a new process. If it fails, land a revert of the landed commits yourself: a delegated agent would run on the broken pi.
- Then tell the owner to restart running pi sessions; they keep the old code until they restart.

## Issues and PRs

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

For testing pi's interactive mode, load and follow [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md).

## Changelog

The fork writes no CHANGELOG entries: `packages/*/CHANGELOG.md` belong to upstream, and fork edits to them conflict at every upstream merge. Describe fork changes in commit messages.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
