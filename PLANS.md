# DSS 2.0 Redesign Plan

Reviewed 2026-08-23 against v1.2.0 (`main`). Full review artifact:
https://claude.ai/code/artifact/00434e4d-22f9-426e-8730-fc847bd71f75

Affected repo: this repo only (`@jalasem/dss`).

## Decisions (approved 2026-08-23)

1. **Naming**: rename "spaces" → **"identities"** in v2 user-facing copy, docs, and new schema.
2. **Breaking-change policy**: legacy commands/behavior emit **deprecation warnings in v2, removed in v3**.
3. **Multi-host**: GitLab/Bitbucket/custom hosts are **in scope for v2** (identity engine and rules must be host-agnostic, not GitHub-only).

## North star

Identity follows context, not a global toggle. Repo binding + directory rules
(compiled to Git-native `includeIf`) become the default way an identity
applies; the global switch remains as an explicit fallback.

## The verdict

The core idea is genuinely good and the repo-binding work is the best code in
the repo (`repoBinding.ts`: Git-native `includeIf`, `execFile`, worktree
awareness, version gating). But the package tells two conflicting stories at
once — global mutable state vs. repo-local binding — while the README promises
commands and flags that don't exist, several commands silently ignore their
arguments, keys are 2016-era RSA generated through an abandoned dependency, and
the interactive-only UX locks out both scripting and coding agents. The
recommendation is a focused v2.0: make repo-local binding the primary model,
cut the low-value bulk/batch surface, rebuild the output layer around one calm
visual voice, and add a first-class non-interactive/JSON mode.

## Correctness findings (verified in source)

- `dss search` documented in README but does not exist; `FuzzySpaceSearch` is
  dead code (import commented out at `src/utils/SpaceManager.ts:10`).
- Space names stored unslugified while dedupe and the SSH key folder use the
  slug (`SpaceManager.ts:67, 78, 105`) — "My Work" breaks completion and
  positional args. CLAUDE.md's slugification claim is false.
- A space created without a key (allowed by `add`, always true after `import`)
  can never be activated — `switch` hard-requires `sshKeyPath`
  (`SpaceManager.ts:183`).
- `dss edit <name>` accepts and ignores its argument (`modifySpace()` takes no
  parameters; `index.ts:66`, `SpaceManager.ts:379`).
- `dss test <name>` documented, but command declared without the argument
  (`index.ts:72`); `SpaceNameArg` unwrapping hack papers over it.
- `inspect` ssh-agent check reports "Key loaded" whenever any identity is
  loaded (`SpaceManager.ts:495`).
- SSH-config rewriting splices on substring `'Host '` — corrupts configs with
  `Host github.com-work`, comments, or `Match` blocks; rewrites wholesale with
  no backup (`src/utils/index.ts:20–32`).
- Almost every failure path exits 0 — only binding commands set
  `process.exitCode`.
- Docs drift: `export --output` / `import --file` don't exist (hardcoded
  `~/dss-export.json`, `batchOperations.ts:102, 116`); README says `remove`
  cleans up SSH keys (it deliberately leaves them); README badge MIT vs
  package.json ISC.
- `modifySpace` renames a space without moving its key directory, updating
  active git config, or touching repo bindings (`SpaceManager.ts:417–434`).
- Minor: interactive select swallows all errors via `.catch(() => null)`
  (`SpaceManager.ts:177`); config JSON minified, non-atomic, unversioned;
  redundant deps `@inquirer/select`, `@types/chalk`,
  `inquirer-autocomplete-prompt`.

## Security & key hygiene

- Keys are RSA (`id_rsa`) via abandoned `ssh-keygen@0.5.0`. Move to Ed25519
  with passphrase option, spawned via system `ssh-keygen -t ed25519` with
  `execFile` (deletes a dependency).
- Shell interpolation of user input: `execSync('git config --global
  user.name "${name}"')`, unquoted `ssh-add ${path}`,
  `echo "${publicKey}" | pbcopy`. Make `execFile` the only pattern.
- macOS agent persistence: `ssh-add` without `--apple-use-keychain` doesn't
  survive reboot; the includeIf-first model eliminates the problem.
- Export hygiene is good (keys excluded); add version + checksum to export.

## Redesigned command surface (v2)

16 commands collapse to 9; legacy names remain as deprecation-warning aliases
until v3.

| Command | Role | Absorbs |
|---|---|---|
| `dss` | Context dashboard: which identity applies here, how (bound / rule / global), health | — |
| `dss ls` | All identities; `--repos` lists bindings | `list` |
| `dss use <id>` | Global switch (explicit fallback); interactive picker with inline fuzzy filter | `switch`, `search`, `batch` |
| `dss new / edit / rm` | CRUD; every prompt has a flag twin (`--name --email --user --key ed25519\|rsa\|none`, `--yes`); `rm` offers honest key deletion | `add`, `edit`, `remove`, `bulk` |
| `dss link / unlink` | Repo binding, the headline feature; keeps `--recursive`, `--dry-run` | `bind`, `unbind`, `status` |
| `dss doctor` | All health checks: key files, permissions, agent, ssh-config, per-identity host auth, drift, wrong-identity commits | `test`, `inspect` |
| `dss key show\|copy\|rotate` | Key lifecycle, with host key-settings links | parts of `add`/`bulk` |
| `dss config export\|import [path]` | Backup/restore with a real path argument | `export`, `import` |
| `dss completion` | Generated from the Commander definition; self-installs with consent | `completion` |

Cut: `batch`, `bulk`, `onboard` (replaced by automatic first-run flow).

## Design language

One accent color, `●`/`✓`/`✗` glyphs instead of emoji, no boxes; hierarchy
from weight/indent/dim. Calm by default (one-line success, `--verbose` for
detail); respect `NO_COLOR`; plain output when piped. Bare `dss` dashboard is
the product's front door.

## Built for coding agents

- Everything scriptable: every prompt has a flag; `--yes` accepts defaults;
  non-TTY stdin (or `DSS_NO_INPUT=1`) → structured error, never a hang.
- Global `--json` on the whole surface.
- Deterministic exit codes: 0 success, 1 failure, 2 usage, 130 cancelled.
- Ship an AGENTS.md recipe block in the package and README.

## Novel features (v2.1, in dependency order)

1. Rules engine: `dss rule add ~/code/acme → work` compiled to native
   `includeIf "gitdir:"`.
2. `dss clone <url>`: identity picked by rule (host/org-aware), cloned with
   the right key, auto-bound.
3. Wrong-identity guard: `doctor` scans commits for author mismatches; opt-in
   pre-commit hook.
4. `dss prompt`: fast cache-backed segment for starship/oh-my-zsh.

## Architecture cleanup

- Layering: `commands/` (thin, prompt-owning) → `core/` (pure logic, no
  console/prompts) → `infra/` (git, ssh, clipboard, store). Break up the
  737-line `SpaceManager.ts`.
- Config store v2: versioned schema (`{ version: 2 }`), `identities` key,
  slugified names, per-key metadata (algorithm, created, fingerprint),
  per-identity host, atomic writes (temp + rename), pretty-printed, silent v1
  migration.
- One exec pattern: `execFile` with argument arrays. Delete `ssh-keygen`,
  `fuzzy-search`, `@inquirer/select`, `@types/chalk`; add `engines`; fix the
  license mismatch.
- Tests that catch this class of bug: CLI-level integration tests against a
  sandboxed `$HOME`/git fixture; docs-vs-`--help` drift check in CI.

## Execution checklist

### Phase 1 — Truth & safety (ships v1.3)

- [x] Save this plan verbatim to `PLANS.md` (this file)
- [ ] Fix `dss edit <name>`: pass and honor the name argument
- [ ] Fix `dss test <name>`: declare `[spaceName]` on the command; remove the `SpaceNameArg` unwrapping hack
- [ ] Slug consistency: store slugified name at creation; slugify lookups for compatibility with existing raw-name configs
- [ ] Keyless-identity trap: `switch` works for a keyless space (sets git config, skips SSH steps, warns) instead of refusing
- [ ] Fix `inspect` ssh-agent detection logic
- [ ] `modifySpace` rename integrity: move key directory, update `sshKeyPath`, update global git config when renaming/editing the active space, update `activeSpace`
- [ ] Exit codes: all failure paths set `process.exitCode = 1`; stop swallowing non-cancel errors in `select().catch()`
- [ ] Replace string-interpolated `exec`/`execSync` with `execFile` in `SpaceManager.ts` and `utils/index.ts` (git config, ssh-add, ssh -T); clipboard via stdin, not `echo`
- [ ] README reconciliation: remove `search` claims; document real export/import behavior; fix `remove` copy (keys stay on disk); align license badge with package.json (flag to owner if MIT was intended)
- [ ] Remove dead code: commented `FuzzySpaceSearch` import; unused deps if trivially safe
- [ ] Tests updated/added for every fix; `npm run build`, `npm run lint`, `npm test` green

### Phase 2 — Identity engine (v2.0 core)

- [ ] Config store v2 (`identities`, versioned, atomic, pretty) + silent v1 migration
- [ ] `core/` / `infra/` / `commands/` layering; split `SpaceManager.ts`
- [ ] Ed25519 default via system ssh-keygen; passphrase + macOS keychain support
- [ ] Host-agnostic identity model (per-identity host: github.com, gitlab.com, bitbucket.org, custom)
- [ ] includeIf-first identity application; global switch reimplemented on top
- [ ] ssh-config handling rewritten as parse-don't-splice with backup, per-host blocks
- [ ] `dss key show|copy|rotate`

### Phase 3 — Surface & voice (v2.0 UX)

- [ ] New command surface (`dss`, `ls`, `use`, `new/edit/rm`, `link/unlink`, `doctor`, `key`, `config`, `completion`)
- [ ] Legacy commands become aliases that print deprecation warnings (removal in v3)
- [ ] Cut `batch`/`bulk`/`onboard`; automatic first-run flow
- [ ] "Identities" rename across all user-facing copy and docs
- [ ] Output layer rewrite: one accent, glyphs not emoji, calm success lines, `NO_COLOR`/pipe handling
- [ ] Bare-`dss` dashboard and `dss doctor`

### Phase 4 — Agents & automation (v2.0 reach)

- [ ] Global `--json`, `--yes`, `DSS_NO_INPUT`/non-TTY behavior
- [ ] Documented + tested exit codes (0/1/2/130)
- [ ] AGENTS.md recipes shipped in package and README
- [ ] Completions generated from the program definition; docs-drift test in CI

### Phase 5 — Delight (v2.1)

- [ ] Rules engine (`dss rule`) compiled to `includeIf gitdir:`
- [ ] `dss clone` (rule/host-aware identity selection + auto-bind)
- [ ] Wrong-identity guard in `doctor` + opt-in pre-commit hook
- [ ] `dss prompt` segment with starship/oh-my-zsh recipes
