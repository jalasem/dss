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
    const maxWidth = Math.min(60, terminalWidth - 4);
    
    console.log('');
    console.log(chalk.cyan('╭' + '─'.repeat(maxWidth) + '╮'));
    
    const titleLength = title.length;
    const padding = Math.max(0, Math.floor((maxWidth - titleLength) / 2));
    const paddedTitle = ' '.repeat(padding) + title + ' '.repeat(maxWidth - titleLength - padding);
    
    console.log(chalk.cyan('│') + chalk.bold.cyan(paddedTitle) + chalk.cyan('│'));
    console.log(chalk.cyan('╰' + '─'.repeat(maxWidth) + '╯'));
    console.log('');
  }

  static printSpaceTable(spaces: Array<{ name: string; email: string; userName: string; sshKeyPath: string }>, activeSpace?: string): void {
    if (spaces.length === 0) {
      this.warning('No spaces have been added yet.');
      return;
    }

    const terminalWidth = process.stdout.columns || 80;
    const maxTableWidth = Math.min(terminalWidth - 4, 100);
    
    // Calculate column widths with responsive sizing
    const baseNameWidth = Math.max(4, ...spaces.map(s => s.name.length));
    const baseEmailWidth = Math.max(5, ...spaces.map(s => s.email.length));
    const baseUserWidth = Math.max(9, ...spaces.map(s => s.userName.length));
    
    // Add status column
    const statusWidth = 8;
    const totalBaseWidth = baseNameWidth + baseEmailWidth + baseUserWidth + statusWidth + 12; // 12 for borders
    
    let nameWidth = baseNameWidth;
    let emailWidth = baseEmailWidth;
    let userWidth = baseUserWidth;
    
    // Adjust widths if table is too wide
    if (totalBaseWidth > maxTableWidth) {
      const availableWidth = maxTableWidth - statusWidth - 12;
      const ratio = availableWidth / (baseNameWidth + baseEmailWidth + baseUserWidth);
      nameWidth = Math.floor(baseNameWidth * ratio);
      emailWidth = Math.floor(baseEmailWidth * ratio);
      userWidth = Math.floor(baseUserWidth * ratio);
    }

    // Print header
    const header = `│ ${chalk.bold('Name'.padEnd(nameWidth))} │ ${chalk.bold('Email'.padEnd(emailWidth))} │ ${chalk.bold('User'.padEnd(userWidth))} │ ${chalk.bold('Status'.padEnd(statusWidth))} │`;
    const separator = `├${'─'.repeat(nameWidth + 2)}┼${'─'.repeat(emailWidth + 2)}┼${'─'.repeat(userWidth + 2)}┼${'─'.repeat(statusWidth + 2)}┤`;
    const topBorder = `┌${'─'.repeat(nameWidth + 2)}┬${'─'.repeat(emailWidth + 2)}┬${'─'.repeat(userWidth + 2)}┬${'─'.repeat(statusWidth + 2)}┐`;
    const bottomBorder = `└${'─'.repeat(nameWidth + 2)}┴${'─'.repeat(emailWidth + 2)}┴${'─'.repeat(userWidth + 2)}┴${'─'.repeat(statusWidth + 2)}┘`;

    console.log(chalk.gray(topBorder));
    console.log(header);
    console.log(chalk.gray(separator));

    // Print spaces
    spaces.forEach(space => {
      const isActive = space.name === activeSpace;
      // const displayName = isActive ? this.activeSpace(space.name) : this.inactiveSpace(space.name);
      
      // Truncate long values
      const truncatedName = space.name.length > nameWidth ? space.name.substring(0, nameWidth - 3) + '...' : space.name;
      const truncatedEmail = space.email.length > emailWidth ? space.email.substring(0, emailWidth - 3) + '...' : space.email;
      const truncatedUser = space.userName.length > userWidth ? space.userName.substring(0, userWidth - 3) + '...' : space.userName;
      
      // Status with color
      const status = isActive ? chalk.green.bold('ACTIVE') : chalk.gray('inactive');
      
      const nameColumn = isActive ? this.activeSpace(truncatedName) : this.inactiveSpace(truncatedName);
      const emailColumn = isActive ? chalk.green(truncatedEmail) : chalk.white(truncatedEmail);
      const userColumn = isActive ? chalk.green(truncatedUser) : chalk.white(truncatedUser);
      
      const row = `│ ${nameColumn.padEnd(nameWidth + (isActive ? 10 : 0))} │ ${emailColumn.padEnd(emailWidth + (isActive ? 10 : 0))} │ ${userColumn.padEnd(userWidth + (isActive ? 10 : 0))} │ ${status.padEnd(statusWidth + (isActive ? 10 : 0))} │`;
      console.log(row);
    });

    console.log(chalk.gray(bottomBorder));
    
    // Add summary footer
    const totalSpaces = spaces.length;
    const activeCount = activeSpace ? 1 : 0;
    const inactiveCount = totalSpaces - activeCount;
    
    console.log(chalk.dim(`\n📊 Summary: ${totalSpaces} total spaces • ${activeCount} active • ${inactiveCount} inactive`));
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
}