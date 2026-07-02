import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { AnalysisReport } from '../../domain/models/report.model';
import { toHtml } from './html-reporter';

/**
 * Renders an AnalysisReport to a PDF file using the system's installed
 * Edge/Chrome browser in headless mode (`--print-to-pdf`). No npm dependency
 * and no bundled Chromium — it reuses the browser already on the machine.
 *
 * Returns the absolute path to the written .pdf file.
 */
export async function toPdf(report: AnalysisReport, outputFile?: string): Promise<string> {
  const browser = findBrowser();
  if (!browser) {
    throw new Error(
      'No Chromium-based browser found to render the PDF. Install Microsoft Edge or Google Chrome, ' +
        'or set the N1NJA_BROWSER environment variable to the browser executable path. ' +
        '(Use format "markdown" if you only need a text report.)',
    );
  }

  const pdfPath = resolveOutputPath(outputFile);

  // Write the HTML to a temp file the browser can load via file:// URL.
  const htmlPath = path.join(
    os.tmpdir(),
    `n1nja-report-${Date.now()}-${Math.random().toString(36).slice(2)}.html`,
  );
  fs.writeFileSync(htmlPath, toHtml(report), 'utf8');

  try {
    await printToPdf(browser, htmlPath, pdfPath);
  } finally {
    fs.rmSync(htmlPath, { force: true });
  }

  if (!fs.existsSync(pdfPath)) {
    throw new Error(`Browser did not produce a PDF at ${pdfPath}.`);
  }
  return pdfPath;
}

// ---------------------------------------------------------------------------

function resolveOutputPath(outputFile?: string): string {
  if (outputFile) {
    const resolved = path.resolve(outputFile);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    return resolved;
  }
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const dir = path.resolve('report');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `n1nja-report_${ts}.pdf`);
}

function printToPdf(browser: string, htmlPath: string, pdfPath: string): Promise<void> {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--no-first-run',
    '--no-default-browser-check',
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ];

  return new Promise<void>((resolve, reject) => {
    const child = spawn(browser, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      // Some Chrome builds exit non-zero even on success; trust the output file.
      if (fs.existsSync(pdfPath)) resolve();
      else reject(new Error(`Headless browser exited with code ${code} and produced no PDF.`));
    });
  });
}

/**
 * Locates a Chromium-based browser. Honors N1NJA_BROWSER, then probes the
 * common Edge/Chrome install locations per platform.
 */
function findBrowser(): string | null {
  const override = process.env.N1NJA_BROWSER;
  if (override && fs.existsSync(override)) return override;

  const candidates = browserCandidates();
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function browserCandidates(): string[] {
  const platform = process.platform;

  if (platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    return [
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    ].filter(Boolean);
  }

  if (platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }

  // linux
  return [
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
}
