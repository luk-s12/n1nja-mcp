import { buildCombinedReport } from '../../src/core/reporting/combined-report';
import { setLanguage } from '../../src/shared/i18n';
import { AnalysisReport } from '../../src/domain/models/report.model';

function makeReport(issues: unknown[]): AnalysisReport {
  return {
    summary: {
      totalQueries: 1,
      uniqueNormalizedQueries: 1,
      detectedIssues: issues.length,
      issuesByType: { N_PLUS_1: issues.length },
      issuesBySeverity: { HIGH: issues.length },
      totalExecutionTimeMs: 0,
      analysisStartedAt: '2026-06-24T00:00:00Z',
      analysisCompletedAt: '2026-06-24T00:00:00Z',
      logFile: 'app.log',
      linesProcessed: 10,
    },
    issues: issues as AnalysisReport['issues'],
    topQueries: [],
  };
}

const issue = {
  type: 'N_PLUS_1',
  severity: 'HIGH',
  query: 'select * from orders where customer_id = ?',
  description: 'N+1 detected',
  recommendation: 'Use JOIN FETCH',
  evidence: ['select * from orders where customer_id = ?'],
  executions: 10,
  estimatedExtraQueries: 9,
};

// Minimal project finding/result with a usage + call chain (heavy nested types cast as any).
function makeProjectResult(): any {
  const finding = {
    issue,
    usages: [
      {
        filePath: 'OrderService.java',
        relativeFilePath: 'src/main/java/OrderService.java',
        className: 'OrderService',
        methodName: 'listOrders',
        lineNumber: 42,
        codeLine: 'order.getItems();',
        codeSnippet: ['order.getItems();'],
        snippetStartLine: 42,
        snippetEndLine: 42,
        isInsideLoop: false,
        layer: 'service',
      },
    ],
    repositoryUsages: [],
    callChains: [
      {
        steps: [
          {
            className: 'OrderController',
            methodName: 'list',
            layer: 'controller',
            relativeFilePath: 'src/main/java/OrderController.java',
            lineNumber: 12,
            httpVerb: 'GET',
            httpPath: '/orders',
          },
        ],
      },
    ],
    fixes: [],
    explanation: '',
    originConfidence: 'confirmed',
  };
  return {
    projectRoot: '.',
    analyzedAt: '',
    entitiesScanned: 1,
    findingsCount: 1,
    findings: [finding],
    markdownReport: '',
  };
}

describe('buildCombinedReport', () => {
  afterEach(() => setLanguage('en'));

  it('renders the English title and the SQL pattern', () => {
    setLanguage('en');
    const md = buildCombinedReport('app.log', makeReport([issue]), null);
    expect(md).toContain('# 🥷 N1nja Report');
    expect(md).toContain('select * from orders where customer_id = ?');
  });

  it('renders the Spanish title when language is es', () => {
    setLanguage('es');
    const md = buildCombinedReport('app.log', makeReport([issue]), null);
    expect(md).toContain('# 🥷 Reporte N1nja');
  });

  it('shows the no-issues message when there are no issues', () => {
    setLanguage('en');
    const md = buildCombinedReport('app.log', makeReport([]), null);
    expect(md).toContain('No issues detected');
  });

  it('uses the localized trigger/flow labels (i18n, not hardcoded Spanish)', () => {
    setLanguage('en');
    const en = buildCombinedReport('app.log', makeReport([issue]), makeProjectResult());
    expect(en).toContain('Request flow that triggers it');
    expect(en).toContain('🔴 N+1 fires here');

    setLanguage('es');
    const es = buildCombinedReport('app.log', makeReport([issue]), makeProjectResult());
    expect(es).toContain('Flujo que dispara el problema');
    expect(es).toContain('🔴 N+1 se dispara aqui');
  });
});
