<a id="cli-and-modes-reference"></a>

# Command Line

This page documents Pi's built-in command-line commands and options. Run `pi --help` or append `--help` to a command for the exact interface in your installed version. The top-level help also includes options registered by loaded extensions.

```sh
pi [options] [--] [@files...] [messages...]
pi auth login <provider> [--api-key] [--no-browser]
pi auth logout <provider>
pi auth <check|print-api-key|print-bearer-token> [options]
```

<a id="modes"></a>

## Invocation and output

```sh
pi
pi --print "Summarize this repository"
git diff | pi --print "Review this change"
```

With terminal stdin and stdout, Pi opens the terminal UI unless `--print` is given. When either stream is redirected, Pi uses print mode. To embed Pi in an application, use the [SDK](sdk.md).

| Input | Behavior |
|---|---|
| `message` | Provide an initial prompt |
| `@path` | Include a text file or image in the first prompt. A later whole-file `read` of an unchanged text file sends the model a short note instead of a second copy |
| Piped stdin | Prepend its contents to the first prompt |
| `--` | Stop option parsing so a prompt can begin with `-` |

Pi resolves `@path` from the current working directory. The working directory also controls project configuration, resource discovery, and session grouping.

| Option | Behavior |
|---|---|
| `-p`, `--print` | Run the supplied prompts, write the final assistant text to stdout, then exit |

<a id="model-options"></a>

## Models

```sh
pi --model sonnet:high
```

See [Choose a Model](models.md) for model selection and [Providers](providers.md) for credentials.

- `--provider <name>`<br>
  Restricts `--model` lookup to one provider. It requires `--model`.
- `--model <pattern>`<br>
  Selects by exact ID or fuzzy ID/name match. It accepts `provider/id` and an optional `:<thinking>` suffix. If several providers match, Pi prefers the one with credentials, otherwise it asks for `--provider`.
- `--api-key <key>`<br>
  Uses a non-persistent API-key override. It requires a model selected through `--model` or `--models`. It does not choose between providers that offer the same model.
- `--thinking <level>`<br>
  Sets `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. It overrides a `--model` suffix and is clamped to the model's capabilities.
- `--models <patterns>`<br>
  Sets a comma-separated scope for startup and cycling. It accepts exact IDs, fuzzy matches, case-insensitive globs, and optional `:<thinking>` suffixes. A model offered by several providers is added for each, with a warning.
- `--list-models [search]`<br>
  Lists available models, optionally filtered by a fuzzy search, then exits.

<a id="session-options"></a>

## Sessions

```sh
pi --continue
```

See [Sessions and Context](sessions.md) for resuming, forking, naming, and storing sessions.

- `-c`, `--continue`<br>
  Continues the most recent session for the current directory.
- `-r`, `--resume`<br>
  Opens the session selector and resumes the chosen session in its working directory. Press Tab to include sessions from other directories.
- `--session <path|id>`<br>
  Opens a session by file path or full/partial ID, and resumes it in its working directory. If the ID only matches sessions stored for another directory, Pi offers to fork it into the current directory instead.
- `--view <file|dir>`<br>
  Shows a session read-only in the normal interface and follows the file as another Pi process appends to it. A directory means its newest `.jsonl` file; a missing file is waited for. The view takes no prompts and never writes the file; the editor line says so, and only exit, scrolling, turn folds, `Ctrl+O`, `Ctrl+T`, `Alt+O` and copy work. A turn folds as soon as its reply is in the file, so a finished one-turn session reads as task, its fold rows with the commentary between them, and reply; a turn still running folds what it finished. The footer names the model and thinking level the session recorded. A file that is replaced, shrinks, or is rewritten with a new header line is shown again from the start; pi's own rewrites always change the header. It loads no extensions, skills, prompt templates, context files or project-local files, does no startup network work, writes no settings at startup, and needs no provider login. It cannot be combined with other session flags, `--name` or a prompt. It calls no model and runs no tools, so it ignores the model, API key, thinking and tool flags and does not check `enabledModels`.
- `--session-id <id>`<br>
  Opens the current directory's existing session with the ID, or creates it otherwise. IDs accept letters, numbers, `.`, `_`, and `-`.
- `--fork <path|id>`<br>
  Forks a session, chosen by file path or full/partial ID, into a new session in the current directory.
- `--session-dir <dir>`<br>
  Overrides storage and lookup. It takes precedence over `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting.
- `--agent-dir <dir>`<br>
  Uses `<dir>` as the config directory (settings, auth, models, resources, and the default session storage) instead of `~/.pi/agent`. It takes precedence over `PI_CODING_AGENT_DIR` and is passed on to processes Pi starts. Works with subcommands too, such as `pi --agent-dir <dir> install <source>`.
- `--no-session`<br>
  Uses an in-memory session that is not persisted.
- `-n`, `--name <name>`<br>
  Sets the session display name.

Constraints:

- Session IDs must start and end with a letter or number.
- `--fork` cannot be combined with `--session`, `--continue`, `--resume`, or `--no-session`.
- `--session-id` cannot be combined with `--session`, `--continue`, or `--resume`. Combine it with `--fork` to choose the new ID.

<a id="tool-options"></a>

## Tools

```sh
pi --tools read,grep,find,ls --print "Review this project"
```

See [Settings](settings.md#tools) for configuring the default tool selection.

- `-t`, `--tools <list>`<br>
  Replaces the default selection with a comma-separated allowlist of built-in, extension, or custom tools. Entries are tool names or patterns where `*` matches any characters. A list of only `+name` and `-name` entries is not an allowlist; it changes the default selection instead.
- `-xt`, `--exclude-tools <list>`<br>
  Disables comma-separated tool names or patterns after all other selection options.
- `-nbt`, `--no-builtin-tools`<br>
  Disables default built-in tools while retaining extension and custom tools.
- `-nt`, `--no-tools`<br>
  Starts with all built-in, extension, and custom tools disabled.

Default enabled tools are `read`, `bash`, `edit`, and `write`, unless `defaultTools` changes them. `--tools` with plain names replaces the whole selection, so name every tool you want. Like `defaultTools`, it also accepts a list of only `+name` and `-name` entries, which adds tools to or removes them from the default selection: `pi --tools +grep,-write` keeps the other default tools, enables `grep`, and disables `write`. These entries take exact tool names, not `*` patterns; use `--exclude-tools` to disable tools by pattern. Plain names and `+name`/`-name` entries cannot be mixed. `/reload` enables tools newly added to `defaultTools`, but a tool removed with `-name` stays removed.

| Built-in | Purpose |
|---|---|
| `read` | Read text files and supported images |
| `bash` | Run shell commands |
| `powershell` | Run PowerShell commands on Windows |
| `edit` | Apply exact text replacements to an existing file |
| `write` | Create or overwrite a file |
| `grep` | Search file contents |
| `find` | Find paths using glob patterns |
| `ls` | List directory contents |

<a id="resource-options"></a>

## Resources

```sh
pi --extension ./review.ts
```

See [Configuration](configuration.md) for conventional directories and project trust, [Settings](settings.md#resources) for configured paths, and [Pi Packages](packages.md) for package sources.

- `-e`, `--extension <path>`<br>
  Loads an extension file or directory, or a built-in extension such as `builtin:llama.cpp`, and is repeatable.
- `-ne`, `--no-extensions`<br>
  Disables discovered, configured, and built-in extensions. Explicit `-e` paths still load, so `pi -ne -e builtin:llama.cpp` keeps only the built-in llama.cpp support.
- `--skill <path>`<br>
  Loads a skill file or directory and is repeatable.
- `-ns`, `--no-skills`<br>
  Disables discovered and configured skills. Explicit `--skill` paths still load.
- `--prompt-template <path>`<br>
  Loads a prompt-template file or directory and is repeatable.
- `-np`, `--no-prompt-templates`<br>
  Disables discovered and configured templates. Explicit `--prompt-template` paths still load.
- `--theme <path>`<br>
  Loads a theme file or directory and is repeatable.
- `--use-theme <name[/name]>`<br>
  Selects the initial interactive theme for this run.
- `--no-themes`<br>
  Disables discovered and configured themes. Explicit `--theme` paths still load.
- `-nc`, `--no-context-files`<br>
  Disables `AGENTS.md` and `CLAUDE.md` discovery.

Resource paths apply only to the current process. Relative paths resolve from the current working directory.

<a id="prompt-and-display-options"></a>

## Prompts and process

```sh
pi --append-system-prompt ./instructions.md
```

See [Configuration](configuration.md) for saved configuration, [Security](security.md#understand-project-trust) for project trust, and [Environment Variables](environment-variables.md) for process controls.

- `--system-prompt <text|path>`<br>
  Replaces the default system prompt with text or the contents of an existing file.
- `--append-system-prompt <text|path>`<br>
  Appends text or an existing file to the system prompt and is repeatable.
- `--tui-mode <mode>`<br>
  Uses `fullscreen` (default) or `regular` terminal mode.
- `--verbose`<br>
  Shows verbose interactive startup information, overriding `quietStartup`.
- `-a`, `--approve`<br>
  Trusts project-local configuration and resources for this process.
- `-na`, `--no-approve`<br>
  Ignores trust-gated project-local configuration and resources for this process.
- `--offline`<br>
  Disables automatic network activity, including model catalog refreshes. Equivalent to `PI_OFFLINE=1`.
- `-h`, `--help`<br>
  Shows help, including flags registered by loaded extensions, then exits.
- `-v`, `--version`<br>
  Shows the Pi version, then exits.

Extensions may register additional long-form options. Unknown short options are rejected.

## Packages

Pi loads packages from local paths listed under `packages` in `settings.json`; it has no package install or update commands. See [Pi Packages](packages.md) for the layout, filtering, and project scope.

## Credential commands

`pi auth login <provider>` logs in to a provider in the terminal and exits, without starting a session. It signs in with an account and opens the browser, like `/login <provider>`. Providers without account sign-in ask for an API key. It requires an interactive terminal.

| Option | Description |
|---|---|
| `--api-key` | Save an API key instead of signing in with an account; the key is read without echoing it |
| `--no-browser` | Do not open a browser; use the provider's other sign-in method, such as a device code, for example over SSH. Asks when there are several. Not allowed with `--api-key` |

`pi auth logout <provider>` removes the credentials that `pi auth login` or `/login` stored, like `/logout`. Environment variables and `models.json` config are unchanged. It exits with status `0` when nothing is stored, so it is safe to repeat.

```sh
pi auth login radius
pi auth logout radius
pi auth check --provider openai --json
```

The other authentication commands require `--provider <provider>` or `--model <model>`. See [Providers](providers.md) for supported methods.

| Command | Description |
|---|---|
| `pi auth check` | Print `ready`, `not_ready`, or `invalid`; exit with status `0`, `1`, or `2`, respectively |
| `pi auth print-api-key` | Print the resolved API key |
| `pi auth print-bearer-token` | Print a resolved OAuth bearer token |

| Option | Applies to | Description |
|---|---|---|
| `--provider <provider>` | All | Resolve credentials for a provider |
| `--model <model>` | All | Resolve credentials from a model; may be combined with `--provider` |
| `--json` | `auth check` | Write the structured result as JSON |
| `--credentials` | `auth check` | Emit the resolved credential when ready |
| `--no-refresh` | `auth check` | Do not refresh expired OAuth credentials; refresh is the default |
| `--min-expiry <duration>` | `print-bearer-token` | Require remaining token lifetime using `ms`, `s`, `m`, or `h`, such as `30m` |

Credential-printing commands write secrets to stdout.
