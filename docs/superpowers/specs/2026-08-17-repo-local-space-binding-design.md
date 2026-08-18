# Repository-Local Space Binding Design

## Summary

DSS currently activates a space by changing global Git identity, the SSH agent,
and `~/.ssh/config`. That model makes two repositories opened at the same time
compete for one active identity. This change adds repository-local binding so
each repository can retain its own DSS space across terminals, VS Code, and
other editors without requiring a global switch before every commit or push.

The existing `dss switch` behavior remains unchanged for backward
compatibility. Repository binding is an additional, explicit workflow.

## Goals

- Bind a DSS space to the current Git repository.
- Bind a space to a repository selected by path.
- Discover and bind multiple child repositories beneath a parent directory.
- Show which space and effective Git identity a repository uses.
- Remove a DSS binding without losing pre-existing repository configuration.
- Ensure binding never changes global Git config, the SSH agent,
  `~/.ssh/config`, VS Code settings, environment files, or tracked files.
- Support commits and pushes initiated by editor Git integrations, not only by
  commands launched from the terminal that performed the binding.

## Non-Goals

- Replacing or changing the existing global `dss switch` command.
- Adding terminal-session or one-command environment modes.
- Automatically binding repositories based on their remote URL.
- Changing repository remotes.
- Managing non-Git project directories.
- Synchronizing bindings between machines; bindings are intentionally local.

## Command Interface

### Bind the current repository

```bash
dss bind [spaceName]
```

When `spaceName` is omitted, DSS prompts with the existing interactive space
selector pattern. The current working directory may be anywhere inside the
repository; DSS resolves the repository root with Git.

### Bind a repository by path

```bash
dss bind [spaceName] --path <repositoryPath>
```

The supplied path may be the repository root or a directory beneath it.

### Bind repositories beneath a parent directory

```bash
dss bind [spaceName] --recursive [parentPath]
dss bind [spaceName] -r [parentPath]
```

When `parentPath` is omitted, DSS searches beneath the current working
directory. This makes `dss bind <space> -r` the normal workflow from a VS Code
integrated terminal opened at the parent folder. When a path is supplied, DSS
searches beneath that directory instead. It prints the sorted repository list
and asks for confirmation before changing any repository. A recursive dry run
prints the same list and intended configuration without prompting or writing.

### Preview binding

```bash
dss bind [spaceName] [--path <repositoryPath> | --recursive [parentPath]] --dry-run
```

### Remove a binding

```bash
dss unbind [--path <repositoryPath>] [--dry-run]
```

This removes only configuration owned by DSS. Any Git settings that were
already present before binding become effective again automatically.

### Inspect binding status

```bash
dss status [--path <repositoryPath>]
```

Status reports the repository root, bound DSS space, configured SSH key, and
effective repository `user.name` and `user.email`. An unbound repository is a
normal successful status, not an error.

`--path` and `--recursive` are mutually exclusive. `-r` is the short form of
`--recursive`. Invalid paths, non-Git directories, empty recursive results,
missing spaces, and spaces without an SSH key produce clear errors and a
non-zero process exit status.

## Storage Model

Each bound repository receives an untracked DSS-owned Git configuration file
inside its Git directory. Its location is resolved with:

```bash
git -C <repository> rev-parse --git-path dss/config
```

The file contains:

```ini
[user]
    name = <space userName>
    email = <space email>
[core]
    sshCommand = ssh -i <safely quoted sshKeyPath> -o IdentitiesOnly=yes
[dss]
    space = <space name>
```

DSS adds that file to the shared local Git config with an
`includeIf.gitdir:<canonical-worktree-git-dir>.path` entry. Git evaluates the
condition against the active worktree's absolute Git directory, so a main
checkout and its linked worktrees can use different DSS spaces without
overwriting one another. The included file remains under that worktree's Git
metadata and therefore cannot be staged or pushed.

Git treats `gitdir:` conditions as glob patterns. DSS escapes glob
metacharacters in the canonical path. Git config subsection names cannot encode
a carriage return or line feed exactly, and replacing either with a wildcard
can match a sibling Git directory. DSS rejects bind and bind dry-run for these
rare canonical Git metadata paths before writing. Status and unbind derive the
former deterministic wildcard condition only to diagnose and remove legacy
experimental bindings.

The include-file approach preserves existing local values rather than
overwriting them. `dss unbind` removes only the exact conditional key and DSS
path for the current worktree, then removes the DSS-owned file. Previously
configured local or global values become effective again without DSS needing
to copy or restore them. DSS never changes `extensions.worktreeConfig`, so
shared `core.worktree`/`core.bare` behavior and dormant `config.worktree` files
remain untouched.

Binding the same repository again atomically updates the DSS-owned file and does
not add a duplicate include. If one or more exact DSS values already exist, DSS
leaves their ordering untouched so interleaved unrelated includes retain their
precedence. Unbind removes every exact DSS value without removing other values
under the same condition. A repository may have unrelated Git include files;
DSS must not modify or remove them.

Bind and mutating unbind operations require Git 2.30 or newer because the
implementation relies on `includeIf.gitdir` and literal `--fixed-value`
removal. DSS parses standard and vendor-suffixed `git --version` output and
fails with an upgrade instruction before any write on unsupported Git. Status
and unbind dry-run remain read-only.

## Components

### Repository binding utility

A focused utility module will:

- Resolve a repository root from a path.
- Resolve the repository-specific DSS config path.
- Build and safely serialize the identity configuration.
- Add or remove the exact worktree-specific conditional include entry.
- Read effective binding status.
- Discover repositories recursively without following symbolic links or
  descending into `.git` and `node_modules` directories.

Git commands will use `execFile`/`spawn` argument arrays rather than shell
interpolation. User-controlled space fields and paths must never be inserted
into an executable shell command.

### CLI handlers

Command handlers will:

- Load the existing `~/.dss/spaces/config.json` data.
- Resolve or interactively select a space.
- Validate that the selected space has an SSH key path.
- Validate mutually exclusive options.
- Render previews, confirmations, per-repository results, and summaries with
  the existing `UIHelper` conventions.
- Set a non-zero exit code when requested work cannot be completed.

### CLI registration

`src/index.ts` will register `bind`, `unbind`, and `status`, and the default
help suggestions and README will document the editor-friendly workflow.

## Recursive Discovery and Failure Handling

Discovery accepts both normal repositories, where `.git` is a directory, and
worktrees/submodules, where `.git` may be a file. Results are canonicalized,
deduplicated, and sorted before display. Symbolic-link directories are not
followed, preventing cycles and surprising traversal outside the requested
parent.

After confirmation, repositories are processed independently. One failure does
not prevent later repositories from being attempted. DSS prints a final count
of bound and failed repositories and sets a non-zero exit code when any failed.
Dry-run mode performs discovery and validation but makes no filesystem or Git
configuration changes.

For a single repository, validation or write failure stops that command and
sets a non-zero exit code. Configuration-file replacement is atomic: write a
temporary file in the same Git directory, rename it into place, then ensure the
include entry exists and retrieve the final effective status. Any failure after
the private file is replaced rolls back the complete invocation before the
error is returned. A newly added exact include is removed, then the previous
private bytes are restored or the newly created file and empty directory are
removed. If the include pre-existed, shared config is not touched. Existing
exact include entries are never removed and re-added during bind, avoiding
shared-config reordering on either success or failure. If rollback itself
fails, DSS reports both the original and rollback errors.

## Security and Privacy

- No command in this feature invokes `git config --global`.
- No command invokes `ssh-add` or edits `~/.ssh/config`.
- No command writes `.vscode`, `.env`, or a path in the repository worktree.
- Private key contents are never read, copied, printed, or stored in Git
  configuration; only the configured key path is referenced.
- Child-process calls pass arguments without a shell.
- Generated config values are escaped using Git's configuration-file quoting
  rules so names, emails, and paths cannot create additional config entries.
- The shared local config stores only a worktree-specific conditional path to
  the private DSS file. Unbind reverses DSS-owned state without enabling or
  disabling repository extensions.

## Testing

Unit and integration tests will use temporary real Git repositories to verify:

- Binding from a nested working directory resolves the correct root.
- Binding creates one DSS include and yields the selected effective name,
  email, SSH command, and `dss.space`.
- Rebinding updates the space without duplicating the include.
- Unbinding removes only the DSS include and file, revealing pre-existing
  local values again.
- Unbinding an unbound repository is idempotent.
- Dry runs make no changes.
- Recursive discovery finds normal repositories and `.git` files, ignores
  excluded directories and symlink loops, and returns deterministic results.
- Recursive binding continues after an individual failure and reports it.
- Spaces and paths containing whitespace and shell metacharacters are treated
  as data, not executed.
- Global Git identity remains unchanged through bind and unbind.
- Existing unrelated `include.path` entries remain unchanged.
- Git output preserves path whitespace while removing only Git's final record
  terminator; raw config reads remain NUL-delimited.
- CR/LF Git metadata paths are rejected without writes or sibling identity
  leakage, while legacy status/unbind cleanup remains available.
- Git versions below 2.30 are rejected before bind/unbind writes.
- CLI help exposes all three commands and their options.

The full existing Jest suite, TypeScript build, lint check, and a manual smoke
test against temporary repositories will be run before the branch is offered
for a pull request.

## Documentation

The README will add a repository-local workflow section covering:

- Binding from a VS Code integrated terminal.
- Binding an explicitly selected repository.
- Binding several child repositories from the current parent directory with
  `dss bind <space> -r`, plus the optional explicit parent-path form.
- Checking and removing a binding.
- The guarantee that binding data lives under `.git/` and is never pushed.
- The distinction between persistent repository binding and global switching.
