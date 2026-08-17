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

DSS adds that file to the repository's local Git config using an
`include.path` entry. Git reads the included values for command-line and editor
operations. The file is under the Git directory and therefore cannot be staged
or pushed.

The include-file approach preserves existing local values rather than
overwriting them. `dss unbind` removes the exact DSS `include.path` value and
then removes the DSS-owned file. Previously configured local or global values
become effective again without DSS needing to copy or restore them.

Binding the same repository again updates the DSS-owned file and does not add a
duplicate include. A repository may have unrelated Git include files; DSS must
not modify or remove them.

## Components

### Repository binding utility

A focused utility module will:

- Resolve a repository root from a path.
- Resolve the repository-specific DSS config path.
- Build and safely serialize the identity configuration.
- Add or remove the exact local `include.path` entry.
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
include entry exists.

## Security and Privacy

- No command in this feature invokes `git config --global`.
- No command invokes `ssh-add` or edits `~/.ssh/config`.
- No command writes `.vscode`, `.env`, or a path in the repository worktree.
- Private key contents are never read, copied, printed, or stored in Git
  configuration; only the configured key path is referenced.
- Child-process calls pass arguments without a shell.
- Generated config values are escaped using Git's configuration-file quoting
  rules so names, emails, and paths cannot create additional config entries.

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
