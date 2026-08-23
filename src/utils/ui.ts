import chalk from 'chalk';
import { performance } from 'perf_hooks';

export class UIHelper {
  static success(message: string): void {
    console.log(chalk.green(`✅ ${message}`));
  }

  static error(message: string): void {
    console.log(chalk.red(`❌ ${message}`));
  }

  static warning(message: string): void {
    console.log(chalk.yellow(`⚠️  ${message}`));
  }

  static info(message: string): void {
    console.log(chalk.blue(`ℹ️  ${message}`));
  }

  static highlight(text: string): string {
    return chalk.cyan(text);
  }

  static dim(text: string): string {
    return chalk.dim(text);
  }

  static bold(text: string): string {
    return chalk.bold(text);
  }

  static activeSpace(name: string): string {
    return chalk.green(`🔥 ${name}`);
  }

  static inactiveSpace(name: string): string {
    return chalk.white(name);
  }

  static spaceName(name: string, isActive: boolean = false): string {
    return isActive ? this.activeSpace(name) : this.inactiveSpace(name);
  }

  static gradient(text: string): string {
    // Create a simple gradient effect using different shades
    const colors = [chalk.blue, chalk.cyan, chalk.green, chalk.yellow];
    const chars = text.split('');
    return chars.map((char, index) => {
      const colorIndex = Math.floor((index / chars.length) * colors.length);
      return colors[colorIndex] ? colors[colorIndex](char) : char;
    }).join('');
  }

  static badge(text: string, type: 'success' | 'error' | 'warning' | 'info' = 'info'): string {
    const colors = {
      success: { bg: chalk.bgGreen, fg: chalk.black },
      error: { bg: chalk.bgRed, fg: chalk.white },
      warning: { bg: chalk.bgYellow, fg: chalk.black },
      info: { bg: chalk.bgBlue, fg: chalk.white }
    };
    
    const { bg, fg } = colors[type];
    return bg(fg(` ${text} `));
  }

  static progressBar(current: number, total: number, width: number = 20): string {
    const percentage = Math.min(current / total, 1);
    const filled = Math.floor(percentage * width);
    const empty = width - filled;
    
    const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
    const percent = Math.floor(percentage * 100);
    
    return `${bar} ${percent}%`;
  }

  static command(cmd: string): string {
    return chalk.cyan(`\`${cmd}\``);
  }

  static filename(path: string): string {
    return chalk.magenta(path);
  }

  static url(url: string): string {
    return chalk.blue.underline(url);
  }

  static printSeparator(): void {
    const terminalWidth = process.stdout.columns || 80;
    const width = Math.min(60, terminalWidth - 4);
    console.log(chalk.gray('─'.repeat(width)));
  }

  static printHeader(title: string): void {
    const terminalWidth = process.stdout.columns || 80;
    const maxWidth = Math.min(Math.max(title.length + 8, 50), terminalWidth - 4);
    
    console.log(chalk.cyan('╭' + '─'.repeat(maxWidth) + '╮'));
    
    const titleLength = title.length;
    const padding = Math.max(0, Math.floor((maxWidth - titleLength) / 2));
    const paddedTitle = ' '.repeat(padding) + title + ' '.repeat(maxWidth - titleLength - padding);
    
    console.log(chalk.cyan('│') + chalk.bold.white(paddedTitle) + chalk.cyan('│'));
    console.log(chalk.cyan('╰' + '─'.repeat(maxWidth) + '╯'));
  }

  // Helper function to get string length without ANSI escape codes
  private static getDisplayLength(str: string): number {
    // Remove ANSI escape codes to get actual display length
    // eslint-disable-next-line no-control-regex
    return str.replace(/\u001b\[[0-9;]*m/g, '').length;
  }

  // Helper function to pad string accounting for ANSI escape codes
  private static padWithColors(str: string, targetLength: number): string {
    const displayLength = this.getDisplayLength(str);
    const padding = Math.max(0, targetLength - displayLength);
    return str + ' '.repeat(padding);
  }

  static printSpaceTable(spaces: Array<{ name: string; email: string; userName: string; sshKeyPath: string }>, activeSpace?: string): void {
    if (spaces.length === 0) {
      this.warning('No spaces have been added yet.');
      return;
    }

    const terminalWidth = process.stdout.columns || 80;
    const maxTableWidth = Math.min(terminalWidth - 4, 120);
    
    // Calculate column widths with responsive sizing
    const minNameWidth = 8;
    const minEmailWidth = 12;
    const minUserWidth = 8;
    const statusWidth = 8;
    
    // Get the actual content lengths
    const baseNameWidth = Math.max(minNameWidth, ...spaces.map(s => s.name.length));
    const baseEmailWidth = Math.max(minEmailWidth, ...spaces.map(s => s.email.length));
    const baseUserWidth = Math.max(minUserWidth, ...spaces.map(s => s.userName.length));
    
    const totalBaseWidth = baseNameWidth + baseEmailWidth + baseUserWidth + statusWidth + 12; // 12 for borders and padding
    
    let nameWidth = baseNameWidth;
    let emailWidth = baseEmailWidth;
    let userWidth = baseUserWidth;
    
    // Adjust widths if table is too wide for terminal
    if (totalBaseWidth > maxTableWidth) {
      const availableWidth = maxTableWidth - statusWidth - 12;
      const totalContentWidth = baseNameWidth + baseEmailWidth + baseUserWidth;
      
      // Proportionally reduce each column
      nameWidth = Math.max(minNameWidth, Math.floor((baseNameWidth / totalContentWidth) * availableWidth));
      emailWidth = Math.max(minEmailWidth, Math.floor((baseEmailWidth / totalContentWidth) * availableWidth));
      userWidth = Math.max(minUserWidth, availableWidth - nameWidth - emailWidth);
    }

    // Create border components
    const topBorder = `┌${'─'.repeat(nameWidth + 2)}┬${'─'.repeat(emailWidth + 2)}┬${'─'.repeat(userWidth + 2)}┬${'─'.repeat(statusWidth + 2)}┐`;
    const separator = `├${'─'.repeat(nameWidth + 2)}┼${'─'.repeat(emailWidth + 2)}┼${'─'.repeat(userWidth + 2)}┼${'─'.repeat(statusWidth + 2)}┤`;
    const bottomBorder = `└${'─'.repeat(nameWidth + 2)}┴${'─'.repeat(emailWidth + 2)}┴${'─'.repeat(userWidth + 2)}┴${'─'.repeat(statusWidth + 2)}┘`;

    // Print table header
    console.log(chalk.cyan(topBorder));
    
    const headerRow = `│ ${this.padWithColors(chalk.bold.white('Name'), nameWidth)} │ ${this.padWithColors(chalk.bold.white('Email'), emailWidth)} │ ${this.padWithColors(chalk.bold.white('User'), userWidth)} │ ${this.padWithColors(chalk.bold.white('Status'), statusWidth)} │`;
    console.log(headerRow);
    console.log(chalk.cyan(separator));

    // Print each space row
    spaces.forEach(space => {
      const isActive = space.name === activeSpace;
      
      // Truncate long values with ellipsis
      const truncatedName = space.name.length > nameWidth ? space.name.substring(0, nameWidth - 3) + '...' : space.name;
      const truncatedEmail = space.email.length > emailWidth ? space.email.substring(0, emailWidth - 3) + '...' : space.email;
      const truncatedUser = space.userName.length > userWidth ? space.userName.substring(0, userWidth - 3) + '...' : space.userName;
      
      // Apply styling based on active state
      const styledName = isActive ? this.activeSpace(truncatedName) : chalk.white(truncatedName);
      const styledEmail = isActive ? chalk.green(truncatedEmail) : chalk.gray(truncatedEmail);
      const styledUser = isActive ? chalk.green(truncatedUser) : chalk.gray(truncatedUser);
      const styledStatus = isActive ? this.badge('ACTIVE', 'success') : chalk.dim('inactive');
      
      const row = `│ ${this.padWithColors(styledName, nameWidth)} │ ${this.padWithColors(styledEmail, emailWidth)} │ ${this.padWithColors(styledUser, userWidth)} │ ${this.padWithColors(styledStatus, statusWidth)} │`;
      console.log(row);
    });

    console.log(chalk.cyan(bottomBorder));
    
    // Enhanced summary footer with better formatting
    const totalSpaces = spaces.length;
    const activeCount = activeSpace ? 1 : 0;
    const inactiveCount = totalSpaces - activeCount;
    
    console.log('');
    console.log(chalk.dim('📊 Summary:'), 
      chalk.cyan(`${totalSpaces} total`), 
      chalk.green(`• ${activeCount} active`), 
      chalk.gray(`• ${inactiveCount} inactive`)
    );
    
    if (activeSpace) {
      console.log('');
      console.log(chalk.dim('🔥 Currently active:'), chalk.green.bold(activeSpace));
    }
    
    console.log('');
    console.log(chalk.dim('Commands:'));
    console.log(chalk.dim('  • '), this.command('dss switch'), chalk.dim(' - Change active space'));
    console.log(chalk.dim('  • '), this.command('dss inspect <space>'), chalk.dim(' - View detailed space info'));
    console.log(chalk.dim('  • '), this.command('dss test'), chalk.dim(' - Test GitHub access'));
    console.log('');
  }

  private static progressState = {
    active: false,
    startTime: 0,
    message: '',
    spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'],
    index: 0,
    interval: null as NodeJS.Timeout | null
  };

  static printProgress(message: string): void {
    this.clearProgress();
    this.progressState.active = true;
    this.progressState.startTime = performance.now();
    this.progressState.message = message;
    this.progressState.index = 0;
    
    const updateSpinner = () => {
      if (!this.progressState.active) return;
      
      const elapsed = Math.floor((performance.now() - this.progressState.startTime) / 1000);
      const spinner = this.progressState.spinner[this.progressState.index % this.progressState.spinner.length];
      const timeStr = elapsed > 0 ? ` (${elapsed}s)` : '';
      
      process.stdout.write(`\r${chalk.yellow(spinner)} ${this.progressState.message}...${chalk.dim(timeStr)}`);
      this.progressState.index++;
    };
    
    updateSpinner();
    this.progressState.interval = setInterval(updateSpinner, 80);
  }

  static clearProgress(): void {
    if (this.progressState.interval) {
      clearInterval(this.progressState.interval);
      this.progressState.interval = null;
    }
    this.progressState.active = false;
    
    const terminalWidth = process.stdout.columns || 80;
    process.stdout.write('\r' + ' '.repeat(terminalWidth) + '\r');
  }

  static updateProgress(message: string): void {
    if (this.progressState.active) {
      this.progressState.message = message;
    }
  }

  static printKeyInstruction(): void {
    console.log(chalk.dim('\n💡 Tips:'));
    console.log(chalk.dim('  • Use arrow keys to navigate'));
    console.log(chalk.dim('  • Press Enter to select'));
    console.log(chalk.dim('  • Press Ctrl+C to cancel'));
  }

  static printSuccessBox(title: string, content: string[]): void {
    const maxWidth = Math.max(title.length, ...content.map(line => line.length));
    const terminalWidth = process.stdout.columns || 80;
    const width = Math.min(Math.max(maxWidth + 4, 40), terminalWidth - 4);
    
    console.log(chalk.green('╔' + '═'.repeat(width - 2) + '╗'));
    console.log(chalk.green('║') + chalk.green.bold(title.padStart((width + title.length) / 2).padEnd(width - 2)) + chalk.green('║'));
    console.log(chalk.green('╠' + '═'.repeat(width - 2) + '╣'));
    
    content.forEach(line => {
      const truncatedLine = line.length > width - 4 ? line.substring(0, width - 7) + '...' : line;
      console.log(chalk.green('║') + ` ${truncatedLine}`.padEnd(width - 2) + chalk.green('║'));
    });
    
    console.log(chalk.green('╚' + '═'.repeat(width - 2) + '╝'));
  }

  static printErrorBox(title: string, content: string[]): void {
    const maxWidth = Math.max(title.length, ...content.map(line => line.length));
    const terminalWidth = process.stdout.columns || 80;
    const width = Math.min(Math.max(maxWidth + 4, 40), terminalWidth - 4);
    
    console.log(chalk.red('╔' + '═'.repeat(width - 2) + '╗'));
    console.log(chalk.red('║') + chalk.red.bold(title.padStart((width + title.length) / 2).padEnd(width - 2)) + chalk.red('║'));
    console.log(chalk.red('╠' + '═'.repeat(width - 2) + '╣'));
    
    content.forEach(line => {
      const truncatedLine = line.length > width - 4 ? line.substring(0, width - 7) + '...' : line;
      console.log(chalk.red('║') + ` ${truncatedLine}`.padEnd(width - 2) + chalk.red('║'));
    });
    
    console.log(chalk.red('╚' + '═'.repeat(width - 2) + '╝'));
  }

  static printInfoBox(title: string, content: string[]): void {
    const maxWidth = Math.max(title.length, ...content.map(line => line.length));
    const terminalWidth = process.stdout.columns || 80;
    const width = Math.min(Math.max(maxWidth + 4, 40), terminalWidth - 4);
    
    console.log(chalk.blue('╔' + '═'.repeat(width - 2) + '╗'));
    console.log(chalk.blue('║') + chalk.blue.bold(title.padStart((width + title.length) / 2).padEnd(width - 2)) + chalk.blue('║'));
    console.log(chalk.blue('╠' + '═'.repeat(width - 2) + '╣'));
    
    content.forEach(line => {
      const truncatedLine = line.length > width - 4 ? line.substring(0, width - 7) + '...' : line;
      console.log(chalk.blue('║') + ` ${truncatedLine}`.padEnd(width - 2) + chalk.blue('║'));
    });
    
    console.log(chalk.blue('╚' + '═'.repeat(width - 2) + '╝'));
  }

  static printStatus(label: string, value: string, status: 'success' | 'error' | 'warning' | 'info' = 'info'): void {
    const statusIcon = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    }[status];
    
    const statusColor = {
      success: chalk.green,
      error: chalk.red,
      warning: chalk.yellow,
      info: chalk.blue
    }[status];
    
    console.log(`${statusIcon} ${chalk.bold(label)}: ${statusColor(value)}`);
  }

  static printWelcome(): void {
    const terminalWidth = process.stdout.columns || 80;
    const maxWidth = Math.min(70, terminalWidth - 4);
    
    console.log('');
    console.log(chalk.cyan('╭' + '═'.repeat(maxWidth) + '╮'));
    console.log(chalk.cyan('║') + chalk.bold.cyan(' '.repeat(Math.floor((maxWidth - 24) / 2)) + '🚀 Dev Spaces Switcher' + ' '.repeat(Math.ceil((maxWidth - 24) / 2))) + chalk.cyan('║'));
    console.log(chalk.cyan('║') + chalk.dim(' '.repeat(Math.floor((maxWidth - 52) / 2)) + 'Manage isolated development environments with ease' + ' '.repeat(Math.ceil((maxWidth - 52) / 2))) + chalk.cyan('║'));
    console.log(chalk.cyan('╰' + '═'.repeat(maxWidth) + '╯'));
    console.log('');
  }

  static printQuickHelp(): void {
    console.log(chalk.dim('Quick commands:'));
    console.log(chalk.dim('  • '), this.command('dss list'), chalk.dim(' - Show all spaces'));
    console.log(chalk.dim('  • '), this.command('dss add'), chalk.dim(' - Add new space'));
    console.log(chalk.dim('  • '), this.command('dss switch'), chalk.dim(' - Switch between spaces'));
    console.log(chalk.dim('  • '), this.command('dss --help'), chalk.dim(' - Show detailed help'));
    console.log('');
  }

  static printSpaceSwitched(spaceName: string): void {
    console.log('');
    console.log(chalk.green('╭─────────────────────────────────────╮'));
    console.log(chalk.green('│') + chalk.green.bold('  ✨ Space Switched Successfully!  ') + chalk.green('│'));
    console.log(chalk.green('├─────────────────────────────────────┤'));
    console.log(chalk.green('│') + chalk.white(`  Active space: ${chalk.green.bold(spaceName)}`.padEnd(35)) + chalk.green('│'));
    console.log(chalk.green('╰─────────────────────────────────────╯'));
    console.log('');
  }
}