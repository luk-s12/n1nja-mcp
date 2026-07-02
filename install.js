#!/usr/bin/env node
// =============================================================================
// N1nja MCP — Cross-platform installer (Node.js)
// =============================================================================
// Usage (Windows, Linux, macOS — same command):
//   node install.js

const { execSync } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
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
const fail    = (msg) => { console.error(`${c.red}[ERROR]${c.reset} ${msg}`); process.exit(1); };

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
console.log(boxLine(`🥷  ${n1(' MCP Installer')}`));
console.log(boxBottom());
console.log('');

// ── Node.js version check ─────────────────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  fail(`Node.js v18+ required. Found: v${process.versions.node}. Upgrade at https://nodejs.org`);
}
success(`Node.js v${process.versions.node}`);

// ── Language selection ────────────────────────────────────────────────────────
function askLanguage() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('');
    console.log(`${c.bold}  Select report language / Seleccione el idioma de los reportes:${c.reset}`);
    console.log('');
    console.log(`    ${c.cyan}[1]${c.reset} English`);
    console.log(`    ${c.cyan}[2]${c.reset} Español`);
    console.log('');
    rl.question('  Enter 1 or 2 (default: 1): ', (answer) => {
      rl.close();
      const lang = answer.trim() === '2' ? 'es' : 'en';
      resolve(lang);
    });
  });
}

// ── Main (async so we can await readline) ─────────────────────────────────────
(async () => {

const LANGUAGE = await askLanguage();
const LANG_LABEL = LANGUAGE === 'es' ? 'Español' : 'English';
success(`Language: ${LANG_LABEL}`);

// ── Install directory ─────────────────────────────────────────────────────────
const INSTALL_DIR = path.join(os.homedir(), '.n1nja');
info(`Install directory: ${INSTALL_DIR}`);

if (fs.existsSync(INSTALL_DIR)) {
  warn(`Existing installation found at ${INSTALL_DIR} — overwriting.`);
  fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
}
fs.mkdirSync(INSTALL_DIR, { recursive: true });

// ── Copy files ────────────────────────────────────────────────────────────────
const SCRIPT_DIR = __dirname;
info(`Copying files from: ${SCRIPT_DIR}`);

const copyRecursive = (src, dst) => {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursive(path.join(src, child), path.join(dst, child));
    }
  } else {
    fs.copyFileSync(src, dst);
  }
};

for (const item of ['src', 'examples', 'package.json', 'tsconfig.json']) {
  copyRecursive(path.join(SCRIPT_DIR, item), path.join(INSTALL_DIR, item));
}

// ── Install dependencies ──────────────────────────────────────────────────────
info('Installing dependencies...');
try {
  execSync('npm install --silent', { cwd: INSTALL_DIR, stdio: 'inherit' });
  success('Dependencies installed');
} catch {
  fail('npm install failed.');
}

// ── Build TypeScript ──────────────────────────────────────────────────────────
info('Building TypeScript...');
try {
  execSync('npm run build', { cwd: INSTALL_DIR, stdio: 'inherit' });
  success('Build complete');
} catch {
  fail('Build failed. Check TypeScript errors above.');
}

const ENTRY_POINT = path.join(INSTALL_DIR, 'dist', 'index.js');

// ── Claude Desktop config ─────────────────────────────────────────────────────
console.log('');
info('Configuring Claude Desktop MCP...');

const claudeConfigDir = (() => {
  switch (process.platform) {
    case 'win32':  return path.join(os.homedir(), 'AppData', 'Roaming', 'Claude');
    case 'darwin': return path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
    default:       return path.join(os.homedir(), '.config', 'Claude');
  }
})();

const claudeConfigFile = path.join(claudeConfigDir, 'claude_desktop_config.json');
const mcpEntry = { command: 'node', args: [ENTRY_POINT] };

fs.mkdirSync(claudeConfigDir, { recursive: true });

let config = { mcpServers: {} };
if (fs.existsSync(claudeConfigFile)) {
  try {
    config = JSON.parse(fs.readFileSync(claudeConfigFile, 'utf8'));
    if (!config.mcpServers) config.mcpServers = {};
  } catch {
    warn('Could not parse existing config — creating fresh.');
  }
}

if (config.mcpServers['n1nja']) {
  warn('MCP already configured — updating entry.');
}

config.mcpServers['n1nja'] = mcpEntry;
fs.writeFileSync(claudeConfigFile, JSON.stringify(config, null, 2), 'utf8');
success(`Configured: ${claudeConfigFile}`);

// ── ~/.claude.json — Claude Code CLI global config ───────────────────────────
const claudeCodeConfig = path.join(os.homedir(), '.claude.json');
let claudeCodeJson = { mcpServers: {} };
if (fs.existsSync(claudeCodeConfig)) {
  try {
    claudeCodeJson = JSON.parse(fs.readFileSync(claudeCodeConfig, 'utf8'));
    if (!claudeCodeJson.mcpServers) claudeCodeJson.mcpServers = {};
  } catch {
    warn('Could not parse ~/.claude.json — will overwrite mcpServers key only.');
  }
}
claudeCodeJson.mcpServers['n1nja'] = mcpEntry;
fs.writeFileSync(claudeCodeConfig, JSON.stringify(claudeCodeJson, null, 2), 'utf8');
success(`Configured Claude Code CLI: ${claudeCodeConfig}`);

// ── Save language config ──────────────────────────────────────────────────────
const n1njaConfig = { language: LANGUAGE };
fs.writeFileSync(path.join(INSTALL_DIR, 'config.json'), JSON.stringify(n1njaConfig, null, 2), 'utf8');
success(`Language saved: ${LANG_LABEL}`);

// ── .mcp.json fallback in current directory ───────────────────────────────────
const mcpJsonPath = path.join(process.cwd(), '.mcp.json');
if (!fs.existsSync(mcpJsonPath)) {
  fs.writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { n1nja: mcpEntry } }, null, 2), 'utf8');
  info('Created .mcp.json in current directory (fallback for Claude Code CLI)');
}

// ── Summary ───────────────────────────────────────────────────────────────────
const isEs = LANGUAGE === 'es';
console.log('');
console.log(boxTop(c.green));
console.log(boxLine(`🥷  ${n1(' installed!')}`, c.green));
console.log(boxBottom(c.green));
console.log('');
console.log(`  ${isEs ? 'Instalado en' : 'Installed to'} : ${ENTRY_POINT}`);
console.log(`  MCP config   : ${claudeConfigFile}`);
console.log(`  ${isEs ? 'Idioma' : 'Language'}       : ${LANG_LABEL}`);
console.log('');
console.log(`  ${isEs ? 'Próximos pasos:' : 'Next steps:'}`);
console.log('');
console.log(`  1. ${isEs ? 'Agregá esto a tu application.yml de Spring Boot:' : 'Add this to your Spring Boot application.yml:'}`);
console.log('');
console.log('     logging:');
console.log('       file:');
console.log('         name: logs/application.log');
console.log('       level:');
console.log('         org.hibernate.SQL: DEBUG');
console.log('         org.hibernate.orm.jdbc.bind: TRACE');
console.log('');
console.log(`  2. ${isEs ? 'Reiniciá Claude Desktop o abrí una nueva sesión de Claude Code' : 'Restart Claude Desktop or open a new Claude Code session'}`);
console.log('');
console.log(`  3. ${isEs ? 'Probalo:' : 'Try it:'}`);
console.log(`     > full_scan`);
console.log('');

})(); // end async main
