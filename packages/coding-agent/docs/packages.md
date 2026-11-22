# Pi Packages

Pi packages bundle extensions, skills, prompt templates, and themes as one unit. Use a package when several resources belong together.

A package is an ordinary directory. It can expose conventional resource directories, declare explicit paths under the `pi` key in `package.json`, and carry its own runtime dependencies.

## Configure packages

List package paths under `packages` in `~/.pi/agent/settings.json`, or in `.pi/settings.json` for one project:

```json
{
  "packages": ["../pi-tools", "/absolute/path/to/another-package"]
}
```

Relative paths resolve from the settings file that contains them. A file path loads one extension. A directory follows normal package discovery rules. Pi loads a package from its path without copying it.

This fork of Pi does not install packages from npm or git. A configured `npm:`, `git:`, or URL source is skipped with a warning that names it, and the other packages keep loading. Install such a package yourself, for example with `npm install` or `git clone`, and configure its local path.

Pi reads declarations from `.pi/settings.json` only after project trust is granted. Packages can execute extension code and can include skills that instruct the model to run programs. Review third-party package source before configuring it. Review project package declarations before granting project trust.

Use `--extension` or `-e` to try a package path for one invocation without adding it to settings:

```bash
pi -e ./pi-tools
```

## Create a package

The simplest package uses conventional directories:

```text
my-pi-package/
├── package.json
├── extensions/
├── skills/
├── prompts/
└── themes/
```

Without a `pi` manifest, Pi discovers TypeScript and JavaScript extensions, skill directories, Markdown prompts, and JSON themes from those directories.

Use an explicit manifest when resources live elsewhere or need filtering:

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./resources/skills"],
    "prompts": ["./resources/prompts/*.md"],
    "themes": ["./resources/themes/*.json"]
  }
}
```

Paths are relative to the package root. Arrays accept glob patterns and exclusions. List dot-prefixed or symlinked resource roots directly when traversal through a glob would not discover them.

## Show a changelog

When a package's version changes, Pi can show what changed. On the next fresh launch, Pi reads the package changelog and shows entries newer than the last seen version under "Extension Updates", the same way it shows its own changelog. The first time Pi sees a package, it records the version without showing anything.

This applies to packages that load at least one extension. Packages that only provide skills, prompt templates, or themes do not show a changelog.

By default Pi reads `CHANGELOG.md` from the package root. Point `pi.changelogPath` at another file inside the package, or set it to `""` to disable the changelog:

```json
{
  "name": "my-pi-package",
  "version": "1.2.0",
  "pi": {
    "changelogPath": "./docs/CHANGELOG.md"
  }
}
```

Use version headings in the same format as Pi's changelog, such as `## [1.2.0]` or `## 1.2.0 - 2026-01-01`. Entries are matched against the `version` field in `package.json`, so a package only shows a changelog when that field increases. The `collapseChangelog` setting condenses the section to one line per package, such as `Updated my-pi-package to v1.2.0.` Unlike Pi's own changelog, `/changelog` does not show package changelogs, so read the package's changelog file or repository for details.

## Declare dependencies

Put runtime packages imported by extensions in `dependencies`. Pi does not install them; run your package manager in the package directory.

Pi supplies these packages to extensions and skills:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

Declare the host-provided packages listed above in `peerDependencies` with a `"*"` range and do not bundle them. Pi does not install or modify packages, so their dependency tree remains the package author's responsibility.

Do not list host-provided packages in `dependencies`. A physical copy can bypass Pi's extension module mapping in compiled ESM and create duplicate classes, registries, and initialization work. Pi reports an extension warning when it detects this manifest configuration. Other Pi packages used as dependencies must be included in the published tarball and referenced through their `node_modules` resource paths.

Installed packages load with separate module roots. Do not rely on two packages sharing one dependency instance or one package resolving another package’s undeclared dependency.

## Select package resources

The object form in settings narrows which resources load from a package:

```json
{
  "packages": [
    {
      "source": "../pi-tools",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"]
    }
  ]
}
```

For each resource type:

- Omit the property to load everything allowed by the package.
- Use `[]` to load none of that type.
- Use `!pattern` to exclude glob matches.
- Use `+path` to include one exact allowed path.
- Use `-path` to exclude one exact path.

Filters narrow the package manifest. They do not expose resources that the package itself did not declare.

## Understand scope and identity

The same package can appear in personal and project settings. A project entry normally replaces the personal entry. With `autoload: false`, the project entry instead acts as a filtering delta over the personal package.

Pi identifies packages by resolved absolute path. This prevents the same package from loading twice through equivalent declarations.

Use [Extensions](extensions.md), [Skills](skills.md), [Prompt Templates](prompt-templates.md), and [Themes](themes.md) to design each resource before packaging it.
