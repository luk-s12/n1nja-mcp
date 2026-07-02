#!/usr/bin/env node
// =============================================================================
// N1nja MCP — Cross-platform uninstaller (Node.js)
// =============================================================================
// Usage (Windows, Linux, macOS — same command):
//   node uninstall.js

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const readline = require('readline');

// ── Colors ────────────────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  bold:   '\x1b[1m',
};

const info    = (msg) => console.log(`${c.cyan}[INFO]${c.reset}  ${msg}`);
const success = (msg) => console.log(`${c.green}[OK]${c.reset}    ${msg}`);
const warn    = (msg) => console.log(`${c.yellow}[WARN]${c.reset}  ${msg}`);

// ── Box helper (handles wide emoji correctly) ─────────────────────────────────
const BOX_WIDTH = 46;
function vw(str) {
  const plain = str.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of plain) {
    if (ch === '🥷') {
      w += 1;
    } else {
      w += ch.codePointAt(0) > 0xFFFF ? 2 : 1;
    }
  }
  return w;
}
const n1 = (suffix = '') => `${c.reset}${c.bold}N${c.cyan}1${c.reset}nja${suffix}`;
function boxLine(text, color = '') {
  const pad = BOX_WIDTH - vw(text);
  const l = Math.floor(pad / 2);
  const r = pad - l;
  return `${c.bold}${color}║${' '.repeat(l)}${text}${c.bold}${color}${' '.repeat(r)}║${c.reset}`;
}
function boxTop(color = '')    { return `${c.bold}${color}╔${'═'.repeat(BOX_WIDTH)}╗${c.reset}`; }
function boxBottom(color = '') { return `${c.bold}${color}╚${'═'.repeat(BOX_WIDTH)}╝${c.reset}`; }

// ── Banner ────────────────────────────────────────────────────────────────────
console.log('');
console.log(boxTop());
console.log(boxLine(`🥷  ${n1(' MCP Uninstaller')}`));
console.log(boxBottom());
console.log('');

// ── Confirm ───────────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Are you sure you want to uninstall N1nja? [y/N] ', (answer) => {
  rl.close();

  if (!answer.match(/^[Yy]$/)) {
    info('Uninstall cancelled.');
    process.exit(0);
  }

  console.log('');

  // ── Remove install directory ────────────────────────────────────────────────
  const installDir = path.join(os.homedir(), '.n1nja');
  if (fs.existsSync(installDir)) {
    info(`Removing ${installDir} ...`);
    fs.rmSync(installDir, { recursive: true, force: true });
    success(`Removed ${installDir}`);
  } else {
    warn(`Install directory not found: ${installDir} — skipping.`);
  }

  // ── Remove from Claude Desktop config ──────────────────────────────────────
  const claudeDesktopDir = (() => {
    switch (process.platform) {
      case 'win32':  return path.join(os.homedir(), 'AppData', 'Roaming', 'Claude');
      case 'darwin': return path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
      default:       return path.join(os.homedir(), '.config', 'Claude');
    }
  })();
  const desktopConfig = path.join(claudeDesktopDir, 'claude_desktop_config.json');
  removeEntry(desktopConfig, 'Claude Desktop');

  // ── Remove from Claude Code global config ───────────────────────────────────
  const claudeCodeConfig = path.join(os.homedir(), '.claude.json');
  removeEntry(claudeCodeConfig, 'Claude Code CLI (~/.claude.json)');

  // ── Remove .mcp.json from current directory ─────────────────────────────────
  const mcpJson = path.join(process.cwd(), '.mcp.json');
  if (fs.existsSync(mcpJson)) {
    try {
      const content = JSON.parse(fs.readFileSync(mcpJson, 'utf8'));
      if (content.mcpServers && content.mcpServers['n1nja']) {
        delete content.mcpServers['n1nja'];
        if (Object.keys(content.mcpServers).length === 0) {
          fs.unlinkSync(mcpJson);
          success('Removed .mcp.json from current directory');
        } else {
          fs.writeFileSync(mcpJson, JSON.stringify(content, null, 2), 'utf8');
          success('Removed n1nja entry from .mcp.json');
        }
      }
    } catch {
      warn('Could not parse .mcp.json — skipping.');
    }
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  console.log('');
  console.log(boxTop(c.green));
  console.log(boxLine(`🥷  ${n1(' uninstalled. Bye!')}`, c.green));
  console.log(boxBottom(c.green));
  console.log('');
  console.log('  Restart Claude Desktop and Claude Code to apply changes.');
  console.log('');
});

// ── Helper ────────────────────────────────────────────────────────────────────
function removeEntry(configPath, label) {
  if (!fs.existsSync(configPath)) {
    warn(`${label} config not found — skipping.`);
    return;
  }
  try {
    const json = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (json.mcpServers && json.mcpServers['n1nja']) {
      delete json.mcpServers['n1nja'];
      fs.writeFileSync(configPath, JSON.stringify(json, null, 2), 'utf8');
      success(`Removed n1nja from ${label}`);
    } else {
      warn(`n1nja not found in ${label} — skipping.`);
    }
  } catch {
    warn(`Could not parse ${label} config — skipping.`);
  }
}
