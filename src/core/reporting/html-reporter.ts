import { AnalysisReport } from '../../domain/models/report.model';
import { toMarkdown } from './markdown-reporter';

/**
 * Renders an AnalysisReport as a self-contained, print-friendly HTML document.
 *
 * Rather than re-implementing the report layout, we reuse the language-aware
 * Markdown output and convert it to HTML with a small, focused converter that
 * understands exactly the constructs `toMarkdown` emits (headings, tables,
 * fenced code blocks, bullet lists, `**bold**`, `` `code` `` and `---` rules).
 *
 * The resulting HTML is meant to be printed to PDF by a headless browser
 * (Edge/Chrome `--print-to-pdf`), so all styling is inlined — no external assets.
 */
export function toHtml(report: AnalysisReport): string {
  const body = markdownToHtml(toMarkdown(report));
  return wrapDocument(body);
}

// ---------------------------------------------------------------------------
// Minimal Markdown → HTML converter (scoped to what the reporter produces)
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Inline formatting: `code` and **bold** (applied to already-escaped text). */
function inline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, b) => `<strong>${b}</strong>`);
  return out;
}

function renderTableRow(row: string, cellTag: 'td' | 'th'): string {
  const cells = row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => `<${cellTag}>${inline(c.trim())}</${cellTag}>`)
    .join('');
  return `<tr>${cells}</tr>`;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
}

function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] ? ` class="lang-${fence[1]}"` : '';
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(escapeHtml(lines[i]));
        i++;
      }
      i++; // skip closing fence
      html.push(`<pre><code${lang}>${code.join('\n')}</code></pre>`);
      continue;
    }

    // Table (header row followed by a separator row)
    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const head = renderTableRow(line, 'th');
      i += 2; // skip header + separator
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(renderTableRow(lines[i], 'td'));
        i++;
      }
      html.push(`<table><thead>${head}</thead><tbody>${rows.join('')}</tbody></table>`);
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      html.push('<hr/>');
      i++;
      continue;
    }

    // Bullet list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i++;
      }
      html.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph (consume consecutive non-blank, non-structural lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i]) &&
      !lines[i].trim().startsWith('|') &&
      !/^\s*[-*]\s+/.test(lines[i])
    ) {
      para.push(inline(lines[i]));
      i++;
    }
    html.push(`<p>${para.join('<br/>')}</p>`);
  }

  return html.join('\n');
}

// ---------------------------------------------------------------------------
// Document shell + print styles
// ---------------------------------------------------------------------------

function wrapDocument(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>N1nja report</title>
<style>
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1b1f24;
    font-size: 12px;
    line-height: 1.55;
    margin: 0;
  }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 22px 0 8px; border-bottom: 1px solid #e1e4e8; padding-bottom: 4px; }
  h3 { font-size: 14px; margin: 16px 0 6px; }
  p { margin: 6px 0; }
  hr { border: 0; border-top: 1px solid #e1e4e8; margin: 18px 0; }
  ul { margin: 6px 0 6px 18px; padding: 0; }
  li { margin: 2px 0; }
  code {
    font-family: "Cascadia Code", Consolas, "SF Mono", Menlo, monospace;
    background: #f3f4f6;
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 11px;
  }
  pre {
    background: #0d1117;
    color: #e6edf3;
    padding: 12px 14px;
    border-radius: 8px;
    overflow-x: auto;
    page-break-inside: avoid;
  }
  pre code { background: transparent; color: inherit; padding: 0; font-size: 11px; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 10px 0;
    page-break-inside: avoid;
  }
  th, td {
    border: 1px solid #d0d7de;
    padding: 6px 9px;
    text-align: left;
    vertical-align: top;
  }
  th { background: #f3f4f6; font-weight: 600; }
  tr:nth-child(even) td { background: #fafbfc; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
