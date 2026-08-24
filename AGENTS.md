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
  mirrors the process exit code (`true` only for exit `0`). `--json` implies
  non-interactive mode, same as `DSS_NO_INPUT=1`.
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
`data: { identity: { name, email, userName, host } | null, source: "bound" | "global" | null, health: { key, agent } | null, identities: number }`.
All four keys are always present — `null` means "not applicable" (no identity resolved), not "omitted".

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
Exit `1` only on a hard failure (any `error`-status check) — warnings alone keep exit `0`.

Rotate an identity's SSH key:

```bash
dss key rotate work --json -y
```
`data: { rotated: string, key: { algorithm, fingerprint } }`

Export / import configuration (SSH keys are never included):

```bash
dss config export ./backup.json --json
dss config import ./backup.json --json -y
```
`export data: { exported: number, path: string }` · `import data: { imported: number, skipped: string[] }`

## Notes

- `dss <command> --help` documents every flag for that command; in `--json` mode,
  `--help`/`--version` also emit JSON (`data.help` / `data.version`) instead of plain text.
- Rules files, repo cloning, and prompt templates are not part of this CLI (planned
  separately, not yet available).
