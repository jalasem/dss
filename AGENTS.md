# AGENTS.md

Recipes for coding agents driving `dss` (Dev Spaces Switcher) non-interactively. See
[README](./README.MD) for the full command reference and concepts.

## What dss manages

`dss` manages named Git/SSH **identities** (name, email, username, host, optional SSH key)
stored in `~/.dss/spaces/config.json`, and applies one globally or binds one to a specific
Git repository.

## Non-interactive contract

- Set `DSS_NO_INPUT=1`, or run with stdin that isn't a TTY (piped/redirected): dss never
  prompts, ever.
- A required confirmation (`rm`, `key rotate`, recursive `link`, `config import`) needs
  `-y`/`--yes` to proceed non-interactively; without it, dss exits `2` rather than hang or
  guess.
- Any other missing required argument/flag with no way to prompt for it also exits `2`.
- Pass `--json` for machine-readable output: exactly one JSON object on stdout,
  `{ ok: boolean, command: string, data?: object, error?: { message: string } }`. `ok`
  mirrors the process exit code (`true` only for exit `0`). `error` is present when
  `ok` is `false`; `data` is present whenever the command produced one — including on
  failure (e.g. `doctor`'s `checks`/`summary`, or a partial `link --recursive`'s
  `bound`/`failed`), so a failure's diagnostic payload is never discarded just because
  the command didn't succeed. `--json` implies non-interactive mode, same as
  `DSS_NO_INPUT=1`.
- Exit codes: `0` success, `1` operational failure, `2` usage error, `130` cancelled
  (prompt closed before an answer). See README's "Exit codes" section for detail.

## Env vars

| Var | Effect |
|---|---|
| `DSS_NO_INPUT=1` | Never prompt; every required input must come from a flag/positional. |
| `NO_COLOR` | Disable colored output (also auto-disabled whenever stdout isn't a TTY). |

## Recipes

Detect the current identity (bound to this repo, or the global default):

```bash
dss --json
```
`data: { identity: { name, email, userName, host } | null, source: "bound" | "rule" | "global" | null, health: { key, agent } | null, identities: number }`.
All four keys are always present — `null` means "not applicable" (no identity resolved), not "omitted". Resolution order: bound (`dss link`) > directory rule (`dss rule add`) > global default (`dss use`).

List all identities:

```bash
dss ls --json
```
`data: { identities: [{ name, email, userName, host, active, hasKey }], active: string | null }`

Create a new identity non-interactively:

```bash
dss new --name work --email me@work.com --user "Jane Doe" --host github.com --key ed25519 --json -y
```
`data: { created: { name, email, userName, host }, key: { algorithm, fingerprint } | null, switched: boolean }`

Switch the global active identity:

```bash
dss use work --json
```
`data: { switched: string, previous: string | null }`

Bind an identity to the current repository:

```bash
dss link work --json -y
```
`data: { bound: [{ path, identity }], failed: [] }`

Run the full health check:

```bash
dss doctor work --json
```
`data: { identity, checks: [{ name, status: "ok" | "warn" | "error", detail }], summary: { ok, warn, error } }`.
Exit `1` only on a hard failure (any `error`-status check) — warnings alone keep exit `0`. `data` is present
even on a hard failure (`ok: false`), alongside `error.message` naming how many checks failed — the
`checks`/`summary` breakdown is exactly what a script needs to tell which check(s) failed.

Rotate an identity's SSH key:

```bash
dss key rotate work --json -y
```
`data: { rotated: string, key: { algorithm, fingerprint }, bindingsRefreshed: number }`

Export / import configuration (SSH keys are never included):

```bash
dss config export ./backup.json --json
dss config import ./backup.json --json -y
```
`export data: { exported: number, path: string }` · `import data: { imported: number, skipped: string[] }`

Add a directory rule (this identity applies automatically to every repository under the
directory, compiled to a native git `includeIf` — no `--json` payload from `dss use`/`dss link`
needed for it to take effect):

```bash
dss rule add ~/code/acme work --json
```
`data: { added: { dir: string, identity: string }, rules: number }`

List / remove directory rules:

```bash
dss rule ls --json
dss rule rm ~/code/acme --json
```
`ls data: { rules: [{ dir, identity }] }` · `rm data: { removed: string, rules: number }`

Clone a repository with the right identity from the first clone (picked by `-i/--identity` >
directory rule matching the destination > exactly-one host match > an error naming
`-i/--identity` if none of those resolve it non-interactively — never guessed):

```bash
dss clone git@github.com:acme/api.git --json
```
`data: { cloned: string, url: string, identity: string, reason: "flag" | "rule" | "host" | "selected", bound: boolean }`.
`reason` is which selection step won. A keyed identity on an ssh URL (scp-like or `ssh://`)
clones with that identity's key (`GIT_SSH_COMMAND`); https/`git://`/local-path URLs never need
one. A local filesystem path is a valid URL too (`host` comes back unset, skipping the
host-match step) — useful for cloning a fixture or another local repository. `bound` is `false`
(not a failure — exit `0`) when the clone itself succeeded but the post-clone bind couldn't be
completed.

Install the wrong-identity guard (an opt-in pre-commit hook that blocks a commit made
under the wrong identity) in the current repository, and check it directly (the same
check the hook itself runs):

```bash
dss guard install --json
dss guard check --json
```
`install data: { installed: string }` — the git-resolved hook path (`.git/hooks/pre-commit`,
worktree-safe). `check data: { ok: boolean, expected: { identity, email, source } | null,
effective: string | null }` — `expected`/`effective` are both `null` when no identity applies
here at all (nothing to guard, exit `0`). Exit `1` on a mismatch (effective git identity here
doesn't match `expected`); `--quiet` suppresses the success line only — a mismatch always
prints. `dss guard uninstall --json` removes the hook (`data: { removed: string | null }`) —
only if DSS installed it; a foreign pre-commit hook is refused (exit `1`) either way.

## Notes

- `dss <command> --help` documents every flag for that command; in `--json` mode,
  `--help`/`--version` also emit JSON (`data.help` / `data.version`) instead of plain text.
- Prompt templates are not part of this CLI (planned separately, not yet available).
- `dss prompt` (a shell-PS1 identity segment for humans, see README's "Shell prompt
  integration" — not something an agent needs to drive) is the one deliberate exception to
  this document's exit-code contract above: it always exits `0`, even on failure, emitting
  `data: { identity: string | null, source: "bound" | "rule" | "global" | null }` rather than
  an `error` object.
