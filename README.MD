<div align="center">

# Dev Spaces Switcher (DSS)

*Manage isolated development identities — separate SSH keys and Git configuration per client, employer, or project.*

[![npm version](https://badge.fury.io/js/%40jalasem%2Fdss.svg)](https://badge.fury.io/js/%40jalasem%2Fdss)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/Built%20with-TypeScript-blue.svg)](https://www.typescriptlang.org/)

---

**Stop hand-editing `~/.gitconfig` and `~/.ssh/config` every time you switch between projects, clients, or employers.**

DSS keeps a set of named **identities** — a name, email, Git host, and (usually) an SSH key — and applies the right one automatically, either globally or pinned to a single repository.

</div>

## Quick Start

Install DSS globally with your preferred package manager:

<table>
<tr>
<td>

**npm**
```bash
npm install -g @jalasem/dss
```

</td>
<td>

**yarn**
```bash
yarn global add @jalasem/dss
```

</td>
<td>

**pnpm**
```bash
pnpm add -g @jalasem/dss
```

</td>
</tr>
</table>

Then just run it:

```bash
dss
```

With no identities configured yet, DSS greets you and offers to create your first one right there — no separate tutorial command. Once you have identities, bare `dss` becomes a fast dashboard: which identity applies in the current directory (repo-bound or global default), and a local health summary (key present, ssh-agent status).

## Identities

An identity is:

- a **name** (slugified for use as an SSH key directory and CLI argument),
- an **email** and **username** (your Git `user.email` / `user.name`),
- a **Git host** — `github.com`, `gitlab.com`, `bitbucket.org`, or any custom host,
- an optional **SSH key**, Ed25519 by default, generated with the system `ssh-keygen` binary (no bundled key-generation dependency). You can set a passphrase; on macOS the key is added to the ssh-agent with `--apple-use-keychain` so the passphrase survives a reboot.

Identities are stored under `~/.dss/spaces/config.json` (schema `version: 2`, versioned and pretty-printed, written atomically). A pre-v2 config is migrated silently the first time it's read.

## Core Commands

| Command | Description |
|---|---|
| `dss` | Dashboard: which identity applies here, and a quick health check |
| `dss ls` | List all identities |
| `dss use [identityName]` | Switch the global active identity (interactive picker if omitted); `--dry-run` previews the change |
| `dss new` | Create a new identity (interactive: name, email, username, host, optional key generation) |
| `dss edit [identityName]` | Modify an existing identity's name, email, username, or host |
| `dss rm [identityName]` | Remove an identity; `--dry-run` previews it. Cannot remove the active identity. Key files are **not** deleted from disk |
| `dss link [identityName]` | Bind an identity to the current repository (or `-p <path>` / `-r [parent]` for recursive binding); `--dry-run` previews |
| `dss unlink` | Remove the repo-local binding (`-p <path>` for an explicit repo) |
| `dss key show\|copy\|rotate [identityName]` | Print, clipboard-copy, or regenerate an identity's SSH key |
| `dss config export\|import [path]` | Back up or restore identity configuration (SSH keys are never included) |
| `dss doctor [identityName]` | Full health check: key files/permissions, ssh-agent, ssh-config, host auth, Git identity drift, repo binding |
| `dss status` | Show the current repository's DSS binding |
| `dss completion [shell]` | Generate a bash/zsh/fish completion script |

Run `dss <command> --help` for the exact options each command accepts.

### Deprecated aliases (removed in v3)

The pre-v2 command names still work, but each prints a deprecation warning to stderr and delegates to its replacement above:

| Old name | New name |
|---|---|
| `list` | `ls` |
| `switch` | `use` |
| `add` | `new` |
| `remove` | `rm` |
| `bind` | `link` |
| `unbind` | `unlink` |
| `export` | `config export` |
| `import` | `config import` |
| `test` | `doctor` |
| `inspect` | `doctor` |

`batch`, `bulk`, and `onboard` are gone entirely, with no alias — replaced by the automatic first-run flow (above) and per-identity `dss key rotate`.

## How switching works

`dss use` doesn't write directly into your own `~/.gitconfig`. It writes `user.name`/`user.email` (and, when the identity has a key, `core.sshCommand`) into a single DSS-managed file, `~/.dss/active.gitconfig`, and makes sure your global Git config `include`s it — an *includeIf-first* model. Switching identities means rewriting one small file, not splicing lines into a file DSS doesn't own. The same key-selection logic also updates the matching `Host` block in `~/.ssh/config` (parsed and rewritten in place, never spliced) and loads the key into the ssh-agent.

## Repository-local binding

Binding is for pinning one identity to a specific repository — the identity your editor's Git integration picks up automatically — independent of your global active identity:

```bash
# From inside a repository
dss link personal

# An explicit path
dss link personal --path ~/Desktop/side-project

# Every Git repository under a parent folder
dss link work --recursive ~/code/acme
dss link work -r ~/code/acme --dry-run   # preview first

# Inspect or remove the current repository's binding
dss status
dss unlink
```

Each binding is a private config file under `.git/`, referenced from the repository's Git config via an `includeIf.gitdir:` condition scoped to that worktree — it's never committed, and different worktrees of the same repository can each be bound to a different identity. `dss unlink` removes only that exact condition and file, leaving `extensions.worktreeConfig` and any unrelated includes untouched. Binding requires Git 2.30 or newer.

## Output

DSS output is calm and scriptable: one accent color, a small glyph set (`●` `✓` `✗` `!`) instead of emoji, and no box-drawing. It respects `NO_COLOR` and automatically degrades to plain ASCII whenever stdout isn't a TTY, so piped or CI output stays greppable. A machine-readable `--json` mode is planned but not available yet.

## Exit codes

DSS follows a deterministic four-code contract, so scripts and coding agents can branch on `$?` instead of scraping output:

| Code | Meaning |
| ---- | ------- |
| `0`   | Success. |
| `1`   | Operational failure — the command ran, but couldn't complete (e.g. an identity, key, or binding that isn't in the state you asked for). |
| `2`   | Usage error — the invocation itself was malformed or incomplete (unknown command/option, a missing required argument, or a required prompt with no way to answer it non-interactively). |
| `130` | Cancelled — a prompt was closed (Ctrl+C, or stdin closed) before it was answered. |

Examples:

```bash
dss use nope            # exit 1 — "nope" isn't an existing identity (operational, not a usage mistake)
DSS_NO_INPUT=1 dss use  # exit 2 — missing the required identityName argument, and no TTY to prompt for it
dss new                 # Ctrl+C at the first prompt → exit 130
```

Deprecated aliases (`dss list`, `dss switch`, `dss add`, ...) follow the exact same contract as the command they delegate to.

## Development

### Contributing

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes** with tests
4. **Run the test suite**: `npm test`
5. **Submit a pull request**

### Local Development

```bash
# Clone and setup
git clone https://github.com/jalasem/dss.git
cd dss
npm install

# Development workflow
npm run dev          # Run in development mode
npm run build        # Build for production
npm run lint         # Check code style
npm test             # Run test suite
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Generate coverage report
```

### Project Structure

```
src/
├── index.ts              # CLI entry point (Commander wiring, deprecated aliases)
├── commands/              # Thin, prompt-owning command handlers
│   ├── spaces.ts          # addSpace, listSpaces, switchSpace, removeSpace, modifySpace
│   ├── binding.ts         # dss link/unlink/status
│   ├── batch.ts           # dss config export/import
│   ├── keys.ts             # dss key show/copy/rotate
│   ├── dashboard.ts       # Bare-`dss` context dashboard
│   ├── doctor.ts          # dss doctor (combined health check)
│   ├── firstRun.ts        # Automatic first-run flow (replaces old `onboard`)
│   ├── completion.ts      # Shell completion script generation
│   ├── prompts.ts         # Shared/cancellation-safe prompt helpers
│   └── ui.ts               # Calm output layer (colors, glyphs, tables, NO_COLOR)
├── core/                   # Dependency-free domain types and lookups
│   ├── types.ts            # ISpace/IIdentity/IStoreV2 and friends
│   ├── identity.ts         # slugify, name validation, identity lookup
│   └── hosts.ts             # Known Git hosts + key-settings links
└── infra/                  # Filesystem, Git, and SSH side effects
    ├── store.ts             # Config store (~/.dss/spaces/config.json, v1→v2 migration)
    ├── git.ts               # active.gitconfig + global include (includeIf-first)
    ├── ssh.ts               # ssh-config (parse-don't-splice) and host access checks
    ├── keys.ts              # SSH key generation (system ssh-keygen binary)
    ├── clipboard.ts          # Platform-specific clipboard operations
    └── repoBinding.ts        # Repository-local Git conditional-include binding
tests/
├── commands/               # Command-layer test suites
├── core/                   # Core-layer test suites
├── infra/                  # Infra-layer test suites
└── ...                     # CLI-level and integration test suites
```

## Use Cases

- **Freelancers & consultants** — a separate identity per client, isolated keys and configs, quick switching.
- **Enterprise developers** — distinct work and personal accounts with different SSH keys.
- **Open source contributors** — personal vs. professional identities without juggling `~/.gitconfig` by hand.
- **Students & educators** — separate school and personal projects with different emails.

## Acknowledgments

- **Contributors**: thank you to everyone who has contributed to this project.
- **Open Source Community**: for the tools and libraries that make this possible.
- **Users**: for feedback, bug reports, and feature requests that help improve DSS.

---

<div align="center">

**Made with ❤️ by developers, for developers**

[Report Bug](https://github.com/jalasem/dss/issues) · [Request Feature](https://github.com/jalasem/dss/issues) · [Documentation](https://github.com/jalasem/dss#readme)

</div>
