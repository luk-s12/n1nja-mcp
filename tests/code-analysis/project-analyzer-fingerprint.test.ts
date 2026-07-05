import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { analyzeProjectForNPlusOne } from '../../src/core/code-analysis/project-analyzer';
import { AnalysisReport } from '../../src/domain/models/report.model';
import { NPlusOneIssue } from '../../src/domain/models/issue.model';

// ── Fixture ───────────────────────────────────────────────────────────────────

let tmpDir: string;

function write(relativePath: string, content: string): void {
  const file = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

const REPOSITORY = `package com.demo;

public interface CashCallRepository {

    @Query(value = "SELECT * FROM cash_call WHERE desk_id = :deskId", nativeQuery = true)
    List<CashCall> findPendingByDesk(@Param("deskId") Long deskId);
}
`;

const SERVICE = `package com.demo;

@Service
public class TreasuryService {

    private final CashCallRepository cashCallRepository;

    public void processDesks(List<Long> deskIds) {
        for (Long deskId : deskIds) {
            cashCallRepository.findPendingByDesk(deskId);
        }
    }
}
`;

function buildReport(query: string): AnalysisReport {
  const issue: NPlusOneIssue = {
    type: 'N_PLUS_1',
    severity: 'HIGH',
    query,
    description: 'N+1 detected',
    recommendation: '',
    evidence: [],
    executions: 12,
    estimatedExtraQueries: 11,
  };
  return {
    summary: {
      totalQueries: 12,
      uniqueNormalizedQueries: 1,
      detectedIssues: 1,
      issuesByType: { N_PLUS_1: 1 },
      issuesBySeverity: { HIGH: 1 },
      totalExecutionTimeMs: 5,
      analysisStartedAt: new Date().toISOString(),
      analysisCompletedAt: new Date().toISOString(),
      logFile: path.join(tmpDir, 'logs', 'application.log'),
      linesProcessed: 100,
    },
    issues: [issue],
    topQueries: [],
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1nja-fingerprint-e2e-'));
  write('src/main/java/com/demo/CashCallRepository.java', REPOSITORY);
  write('src/main/java/com/demo/TreasuryService.java', SERVICE);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── End-to-end attribution ───────────────────────────────────────────────────

describe('analyzeProjectForNPlusOne — native @Query fingerprint', () => {
  it('attributes the logged SQL to the native @Query method and finds its caller', () => {
    const report = buildReport('select * from cash_call where desk_id=?');

    const result = analyzeProjectForNPlusOne(tmpDir, report);
    const finding = result.findings[0];

    // Direct attribution to the repository method.
    expect(finding.queryFingerprintMatches).toHaveLength(1);
    const match = finding.queryFingerprintMatches![0];
    expect(match.usage.repositoryName).toBe('CashCallRepository');
    expect(match.usage.methodName).toBe('findPendingByDesk');
    expect(match.confidence).toBe('exact');

    // The caller (service method) becomes the code location.
    expect(finding.usages.length).toBeGreaterThan(0);
    expect(finding.usages[0].className).toBe('TreasuryService');

    // The matched method leads the repository usages and the explanation.
    expect(finding.repositoryUsages[0].methodName).toBe('findPendingByDesk');
    expect(finding.explanation).toContain('findPendingByDesk');
    expect(result.markdownReport).toContain('Native @Query match');
  });

  it('leaves findings without fingerprint matches unchanged', () => {
    const report = buildReport('select * from users where id=?');

    const result = analyzeProjectForNPlusOne(tmpDir, report);
    const finding = result.findings[0];

    expect(finding.queryFingerprintMatches).toBeUndefined();
    expect(result.markdownReport).not.toContain('Native @Query match');
  });
});
