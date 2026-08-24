import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { Command } from 'commander';
import { UIHelper } from './ui';
import { guardedSelect, guardedConfirm, UsageError } from './prompts';
import { jsonData } from './jsonOutput';

// --- describeProgram: walks a Commander `program` into a plain, derivable
// description the three shell generators (and tests/docsDrift.test.ts) work
// from, instead of each maintaining its own hand-copied command/option
// list. See src/cli/program.ts for how the live `program` reaches here
// (closure, passed by index.ts's buildProgram — completion.ts itself never
// imports index.ts, avoiding the import cycle that would otherwise create).

export interface DescribedOption {
  flags: string;
  description: string;
}

export interface DescribedCommand {
  /** The command's own name, e.g. "use", "export", "show" (not a full path). */
  name: string;
  /** Full space-joined path from the root, e.g. "config export". */
  path: string;
  /** Registered positional argument names, in order (e.g. ["identityName"], or ["action", "identityName"] for `key`). */
  args: string[];
  description: string;
  /** This command's own options (excludes inherited/global ones). */
  options: DescribedOption[];
  /** Nested Commander subcommands (config export/import) OR, when Commander
   * has no subcommands of its own to walk, the small explicit-choices
   * fallback below (key show/copy/rotate; completion's own shell argument). */
  subcommands: DescribedCommand[];
  /** True for a hidden deprecated alias (list, switch, add, ...) — excluded
   * from every generator's ADVERTISED output, same policy the hand-written
   * scripts followed before this rewrite. */
  hidden: boolean;
  /** True when this command's FIRST positional argument is named
   * "identityName" — i.e. the identity name is the token immediately after
   * the command word, which is what makes it completable by the simple
   * "previous word was <command>" heuristic every generator below uses.
   * (`key <action> [identityName]`'s identityName is its SECOND argument,
   * so `key` is deliberately excluded — matches the pre-rewrite behavior,
   * which never offered identity-name completion for `key <action> <TAB>`
   * either.) */
  takesIdentityName: boolean;
}

export interface DescribedProgram {
  commands: DescribedCommand[];
  globalOptions: DescribedOption[];
}

// Commander v12 doesn't expose either of these two things publicly:
//
// 1. Whether a Command is hidden — only as the internal `_hidden` field set
//    by `{ hidden: true }` at `.command()` time (src/cli/program.ts's
//    deprecatedAlias). There's no supported public getter for it.
// 2. Declared choices for `key`'s `<action>` argument or `completion`'s
//    `[shell]` argument — Commander only tracks `argChoices` for an
//    Argument built with `.choices(...)`, and neither one is (adding
//    `.choices(['show','copy','rotate'])` to `key`'s action argument would
//    change CLI behavior: Commander would then reject an unknown action
//    itself, at exit code 2, instead of keys.ts's own `fail()` call at exit
//    code 1 — see keys.ts's `keyCommand` — which the brief for this task
//    rules out).
//
// Both are covered by small, explicit, narrowly-scoped fallbacks instead —
// exactly the fallback the brief calls out for the `key` case.
function isHiddenCommand(cmd: Command): boolean {
  return Boolean((cmd as unknown as { _hidden?: boolean })._hidden);
}

const EXPLICIT_SUBCOMMAND_CHOICES: Record<string, string[]> = {
  key: ['show', 'copy', 'rotate'],
  completion: ['bash', 'zsh', 'fish'],
};

function describeOptions(cmd: Command): DescribedOption[] {
  return cmd.options.map(option => ({ flags: option.flags, description: option.description }));
}

function describeCommand(cmd: Command, parentPath: string): DescribedCommand {
  const name = cmd.name();
  const commandPath = parentPath ? `${parentPath} ${name}` : name;
  const args = cmd.registeredArguments.map(argument => argument.name());
  const explicitChoices = EXPLICIT_SUBCOMMAND_CHOICES[name];

  const subcommands = cmd.commands.length > 0
    ? cmd.commands.map(sub => describeCommand(sub, commandPath))
    : (explicitChoices ?? []).map(choice => ({
        name: choice,
        path: `${commandPath} ${choice}`,
        args: [],
        description: '',
        options: [],
        subcommands: [],
        hidden: false,
        takesIdentityName: false,
      }));

  return {
    name,
    path: commandPath,
    args,
    description: cmd.description(),
    options: describeOptions(cmd),
    subcommands,
    hidden: isHiddenCommand(cmd),
    takesIdentityName: args[0] === 'identityName',
  };
}

export function describeProgram(program: Command): DescribedProgram {
  return {
    commands: program.commands.map(cmd => describeCommand(cmd, '')),
    globalOptions: describeOptions(program),
  };
}

// --- Small shared helpers the three generators below all use ------------

function advertisedCommands(described: DescribedProgram): DescribedCommand[] {
  return described.commands.filter(cmd => !cmd.hidden);
}

/** '-p, --path <repositoryPath>' -> ['-p', '--path']; '--json' -> ['--json'].
 * Exported for tests/docsDrift.test.ts, which reuses this exact tokenizer
 * to check AGENTS.md's `--flag` usages against real command/global options
 * — reusing it (instead of a second hand-rolled parser in the test) is what
 * keeps the drift check from drifting from the generators it's meant to
 * guard. */
export function flagTokens(flags: string): string[] {
  return flags
    .split(',')
    .map(part => part.trim().split(/\s+/)[0])
    .filter(token => token.startsWith('-'));
}

function uniqueFlagTokens(options: DescribedOption[]): string[] {
  return Array.from(new Set(options.flatMap(option => flagTokens(option.flags))));
}

/** Whether an option's flags declare a value placeholder (`<...>` required or `[...]` optional) — used to decide fish's `-r` ("takes an argument") marker. */
function optionTakesValue(flags: string): boolean {
  return /[<[]/.test(flags);
}

function identityNameCommands(described: DescribedProgram): DescribedCommand[] {
  return advertisedCommands(described).filter(cmd => cmd.takesIdentityName);
}

/** '-h'/'--help' are Commander's own always-on built-in (never disabled by
 * this CLI, so not worth a fragile reach into Commander internals to
 * "derive" it) — every other global flag (--json, -y/--yes, -v/--version)
 * comes straight from `described.globalOptions`. Exported for the same
 * reason as `flagTokens` above. */
export function globalFlagTokens(described: DescribedProgram): string[] {
  return Array.from(new Set(['-h', '--help', ...described.globalOptions.flatMap(option => flagTokens(option.flags))]));
}

function zshEscape(text: string): string {
  return text.replace(/'/g, `'\\''`);
}

export async function generateCompletionScript(shell: string | undefined, program: Command): Promise<void> {
  UIHelper.printHeader('Shell Completion Setup');

  let selectedShell = shell;
  if (!selectedShell) {
    selectedShell = await guardedSelect({
      message: 'Select your shell:',
      choices: [
        { name: 'Bash', value: 'bash' },
        { name: 'Zsh', value: 'zsh' },
        { name: 'Fish', value: 'fish' }
      ],
      flagName: 'the shell argument',
    });
  }

  const described = describeProgram(program);
  const completionScript = generateScript(selectedShell, described);

  if (!completionScript) {
    // An unsupported shell value (e.g. "tcsh") is a bad argument value, not
    // an operational failure — matches every other invalid-flag-value path
    // in this codebase (UsageError, exit 2) instead of printing an error
    // and exiting 0 (review finding #4).
    throw new UsageError(`Completion script for "${selectedShell}" is not supported yet (expected bash, zsh, or fish).`);
  }

  UIHelper.printInfoBox('Completion Script Generated', [
    `Generated completion script for ${selectedShell}`,
    'Copy the script below to enable auto-completion',
    '',
    'Installation instructions will be shown after the script'
  ]);

  UIHelper.print('\n' + UIHelper.dim('--- Completion Script ---'));
  UIHelper.print(completionScript);
  UIHelper.print(UIHelper.dim('--- End of Script ---\n'));

  jsonData({ shell: selectedShell, script: completionScript });

  // Show installation instructions
  showInstallationInstructions(selectedShell);

  // Optional/informational: the script was already printed above, so
  // non-interactive mode without -y silently declines instead of erroring.
  const saveScript = await guardedConfirm({
    message: 'Would you like to save this script to a file?',
    default: true,
    optional: true,
  });

  if (saveScript) {
    const scriptPath = path.join(os.homedir(), `dss-completion.${selectedShell}`);
    await fs.writeFile(scriptPath, completionScript);
    UIHelper.success(`Completion script saved to: ${UIHelper.filename(scriptPath)}`);

    UIHelper.printInfoBox('Next Steps', [
      `1. Source the script in your ${selectedShell} configuration:`,
      `   source ${scriptPath}`,
      '',
      '2. Or follow the installation instructions above',
      '3. Restart your terminal or run the source command',
      '4. Try: dss <TAB> to see available commands'
    ]);
  }
}

function generateScript(shell: string, described: DescribedProgram): string | null {
  switch (shell) {
    case 'bash':
      return generateBashScript(described);
    case 'zsh':
      return generateZshScript(described);
    case 'fish':
      return generateFishScript(described);
    default:
      return null;
  }
}

export function generateBashScript(described: DescribedProgram): string {
  const commands = advertisedCommands(described);
  const topLevelOpts = [...commands.map(cmd => cmd.name), ...globalFlagTokens(described)].join(' ');

  const identityCondition = identityNameCommands(described)
    .map(cmd => `$prev == "${cmd.name}"`)
    .join(' || ') || 'false';

  const caseLines = commands
    .map(cmd => {
      if (cmd.subcommands.length > 0) {
        return `        ${cmd.name})\n            opts="${cmd.subcommands.map(sub => sub.name).join(' ')}"\n            ;;`;
      }
      if (cmd.options.length > 0) {
        const flags = uniqueFlagTokens(cmd.options).join(' ');
        return `        ${cmd.name})\n            if [[ $cur == -* ]]; then\n                opts="${flags}"\n            fi\n            ;;`;
      }
      return null;
    })
    .filter((line): line is string => line !== null)
    .join('\n');

  return `#!/bin/bash
# DSS (Dev Spaces Switcher) Bash Completion Script

_dss_completion() {
    local cur prev command opts
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    command="\${COMP_WORDS[1]}"

    # Main commands
    opts="${topLevelOpts}"

    # Get identity names for relevant commands
    if [[ $cur != -* && (${identityCondition}) ]]; then
        local spaces
        if [ -f ~/.dss/spaces/config.json ]; then
            spaces=$(cat ~/.dss/spaces/config.json | grep -o '"name": *"[^"]*"' | cut -d'"' -f4 | tr '\n' ' ')
            COMPREPLY=( $(compgen -W "$spaces" -- $cur) )
            return 0
        fi
    fi

    # Options for specific commands
    case $command in
${caseLines}
    esac

    COMPREPLY=( $(compgen -W "$opts" -- $cur) )
    return 0
}

complete -F _dss_completion dss
`;
}

export function generateZshScript(described: DescribedProgram): string {
  const commands = advertisedCommands(described);
  const versionOption = described.globalOptions.find(option => flagTokens(option.flags).includes('--version'));

  const commandEntries = [
    ...commands.map(cmd => `        '${cmd.name}:${zshEscape(cmd.description)}'`),
    `        '--help:Show help information'`,
    `        '--version:${zshEscape(versionOption?.description ?? 'Show version information')}'`
  ].join('\n');

  const identityOnly = commands.filter(cmd => cmd.takesIdentityName && cmd.options.length === 0);
  const identityWithOptions = commands.filter(cmd => cmd.takesIdentityName && cmd.options.length > 0);
  const optionOnly = commands.filter(cmd => !cmd.takesIdentityName && cmd.options.length > 0 && cmd.subcommands.length === 0);
  const withSubcommands = commands.filter(cmd => cmd.subcommands.length > 0);

  const zshValues = (label: string, options: DescribedOption[]): string => {
    const entries = options
      .flatMap(option => flagTokens(option.flags).map(token => `                        '${token}[${zshEscape(option.description)}]'`))
      .join(' \\\n');
    return `_values '${label} options' \\\n${entries}`;
  };

  const caseParts: string[] = [];

  if (identityOnly.length > 0) {
    caseParts.push(`                ${identityOnly.map(cmd => cmd.name).join('|')})\n                    _describe 'spaces' spaces\n                    ;;`);
  }

  for (const cmd of identityWithOptions) {
    caseParts.push(`                ${cmd.name})
                    if [[ $CURRENT -eq 3 && \${words[CURRENT]} != -* ]]; then
                        _describe 'spaces' spaces
                    else
                        ${zshValues(cmd.name, cmd.options)}
                    fi
                    ;;`);
  }

  for (const cmd of optionOnly) {
    caseParts.push(`                ${cmd.name})\n                    ${zshValues(cmd.name, cmd.options)}\n                    ;;`);
  }

  for (const cmd of withSubcommands) {
    const values = cmd.subcommands.map(sub => `'${sub.name}'`).join(' ');
    caseParts.push(`                ${cmd.name})\n                    _values '${cmd.name} options' ${values}\n                    ;;`);
  }

  return `#!/bin/zsh
# DSS (Dev Spaces Switcher) Zsh Completion Script

_dss() {
    local context state state_descr line
    local -a commands spaces

    commands=(
${commandEntries}
    )

    # Get identity names
    if [[ -f ~/.dss/spaces/config.json ]]; then
        spaces=($(grep -o '"name": *"[^"]*"' ~/.dss/spaces/config.json | cut -d'"' -f4))
    fi

    _arguments -C \\
        '1: :->command' \\
        '*: :->args' && return 0

    case $state in
        command)
            _describe 'commands' commands
            ;;
        args)
            case $words[2] in
${caseParts.join('\n')}
            esac
            ;;
    esac
}

compdef _dss dss
`;
}

export function generateFishScript(described: DescribedProgram): string {
  const commands = advertisedCommands(described);
  const versionOption = described.globalOptions.find(option => flagTokens(option.flags).includes('--version'));
  const identityCommandNames = identityNameCommands(described).map(cmd => cmd.name).join(' ');

  const commandLines = commands
    .map(cmd => `complete -c dss -n '__fish_use_subcommand' -a '${cmd.name}' -d '${cmd.description.replace(/'/g, "\\'")}'`)
    .join('\n');

  const optionLines = commands
    .flatMap(cmd => cmd.options.map(option => {
      const tokens = flagTokens(option.flags);
      const short = tokens.find(token => /^-[^-]/.test(token));
      const long = tokens.find(token => token.startsWith('--'));
      const parts = [`complete -c dss -n '__fish_seen_subcommand_from ${cmd.name}'`];
      if (short) parts.push(`-s ${short.slice(1)}`);
      if (long) parts.push(`-l ${long.slice(2)}`);
      if (optionTakesValue(option.flags)) parts.push('-r');
      const flagLabel = long ?? short ?? '';
      parts.push(`-d '${option.description.replace(/'/g, "\\'")} (${flagLabel})'`);
      return parts.join(' ');
    }))
    .join('\n');

  const subcommandLines = commands
    .filter(cmd => cmd.subcommands.length > 0)
    .map(cmd => `complete -c dss -n '__fish_seen_subcommand_from ${cmd.name}' -a '${cmd.subcommands.map(sub => sub.name).join(' ')}' -d '${cmd.name === 'completion' ? 'Shell type' : cmd.name.charAt(0).toUpperCase() + cmd.name.slice(1) + ' action'}'`)
    .join('\n');

  return `#!/usr/bin/env fish
# DSS (Dev Spaces Switcher) Fish Completion Script

# Function to get identity names
function __dss_get_spaces
    if test -f ~/.dss/spaces/config.json
        cat ~/.dss/spaces/config.json | grep -o '"name": *"[^"]*"' | cut -d'"' -f4
    end
end

# Main completion function
complete -c dss -f

# Commands
${commandLines}

# Global options
complete -c dss -n '__fish_use_subcommand' -l help -s h -d 'Show help information'
complete -c dss -n '__fish_use_subcommand' -l version -s v -d '${(versionOption?.description ?? 'Show version information').replace(/'/g, "\\'")}'

# Identity name completions for relevant commands
complete -c dss -n '__fish_seen_subcommand_from ${identityCommandNames}' -a '(__dss_get_spaces)'

# Options for specific commands
${optionLines}

# Actions for subcommands (key, config, completion)
${subcommandLines}
`;
}

function showInstallationInstructions(shell: string): void {
  UIHelper.printHeader('Installation Instructions');

  switch (shell) {
    case 'bash':
      UIHelper.printInfoBox('Bash Installation', [
        '1. Add to ~/.bashrc or ~/.bash_profile:',
        '   source /path/to/dss-completion.bash',
        '',
        '2. Or copy to system completion directory:',
        '   sudo cp dss-completion.bash /etc/bash_completion.d/',
        '',
        '3. Restart your terminal or run:',
        '   source ~/.bashrc'
      ]);
      break;

    case 'zsh':
      UIHelper.printInfoBox('Zsh Installation', [
        '1. Add to ~/.zshrc:',
        '   source /path/to/dss-completion.zsh',
        '',
        '2. Or copy to zsh completion directory:',
        '   cp dss-completion.zsh ~/.oh-my-zsh/completions/_dss',
        '',
        '3. Restart your terminal or run:',
        '   source ~/.zshrc'
      ]);
      break;

    case 'fish':
      UIHelper.printInfoBox('Fish Installation', [
        '1. Copy to fish completion directory:',
        '   cp dss-completion.fish ~/.config/fish/completions/',
        '',
        '2. Or manually load:',
        '   source dss-completion.fish',
        '',
        '3. Restart your terminal or run:',
        '   fish'
      ]);
      break;
  }
}
