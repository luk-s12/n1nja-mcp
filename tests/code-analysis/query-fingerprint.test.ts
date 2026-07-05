import {
  fingerprintAnnotationSql,
  stripPaginationSuffix,
  buildQueryFingerprintIndex,
  matchQueryFingerprint,
} from '../../src/core/code-analysis/query-fingerprint';
import { RepositoryUsage } from '../../src/core/code-analysis/repository-scanner';

// ── Helpers ───────────────────────────────────────────────────────────────────

function nativeUsage(overrides: Partial<RepositoryUsage>): RepositoryUsage {
  return {
    filePath: '/p/src/main/java/com/demo/CashCallRepository.java',
    relativeFilePath: 'src/main/java/com/demo/CashCallRepository.java',
    repositoryName: 'CashCallRepository',
    methodName: 'findPendingByDesk',
    lineNumber: 42,
    codeLine: 'List<CashCall> findPendingByDesk(@Param("deskId") Long deskId);',
    codeSnippet: [],
    snippetStartLine: 40,
    snippetEndLine: 44,
    queryText: 'SELECT * FROM cash_call WHERE desk_id = :deskId',
    isNative: true,
    isJoinFetch: false,
    kind: 'query_annotation',
    ...overrides,
  };
}

// ── fingerprintAnnotationSql ─────────────────────────────────────────────────

describe('fingerprintAnnotationSql', () => {
  it('converges annotation SQL and logged SQL despite spacing and casing differences', () => {
    // Annotation style: spaces around operators, named param, uppercase.
    const annotation = "SELECT * FROM cash_call WHERE desk_id = :deskId AND status = 'PENDING'";
    // Hibernate log style: no spaces around '=', bind already a '?'.
    const logged = "select * from cash_call where desk_id=? and status='PENDING'";

    const index = buildQueryFingerprintIndex([nativeUsage({ queryText: annotation })]);
    expect(matchQueryFingerprint(logged, index)).toHaveLength(1);
  });

  it('replaces named, positional and SpEL parameters with ?', () => {
    const fp = fingerprintAnnotationSql(
      'SELECT * FROM t WHERE a = :name AND b = ?1 AND c = :#{#filter.status} AND d = ?#{#p}',
    );
    expect(fp).not.toContain(':name');
    expect(fp).not.toContain('?1');
    expect(fp).not.toContain('#{');
  });

  it('does not mangle SQL casts using double colons', () => {
    const fp = fingerprintAnnotationSql("SELECT total::int FROM t WHERE id = :id");
    expect(fp).toContain('total::int');
  });
});

// ── stripPaginationSuffix ────────────────────────────────────────────────────

describe('stripPaginationSuffix', () => {
  it.each([
    ['select * from t where a = ? limit ?', 'select * from t where a = ?'],
    ['select * from t where a = ? limit ?, ?', 'select * from t where a = ?'],
    ['select * from t where a = ? limit ? offset ?', 'select * from t where a = ?'],
    ['select * from t offset ? rows', 'select * from t'],
    ['select * from t fetch first ? rows only', 'select * from t'],
  ])('strips %s', (input, expected) => {
    expect(stripPaginationSuffix(input)).toBe(expected);
  });

  it('leaves queries without pagination untouched', () => {
    const q = 'select * from t where limit_amount = ?';
    expect(stripPaginationSuffix(q)).toBe(q);
  });
});

// ── Index + matching ─────────────────────────────────────────────────────────

describe('buildQueryFingerprintIndex / matchQueryFingerprint', () => {
  it('matches a logged native query to its @Query method (exact)', () => {
    const index = buildQueryFingerprintIndex([nativeUsage({})]);

    const matches = matchQueryFingerprint(
      "select * from cash_call where desk_id=?",
      index,
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].usage.methodName).toBe('findPendingByDesk');
    expect(matches[0].confidence).toBe('exact');
  });

  it('matches a paginated log query against a Pageable method (no-pagination)', () => {
    const index = buildQueryFingerprintIndex([nativeUsage({})]);

    const matches = matchQueryFingerprint(
      'select * from cash_call where desk_id=? limit ?, ?',
      index,
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].confidence).toBe('no-pagination');
  });

  it('returns every candidate when the same SQL is declared twice', () => {
    const index = buildQueryFingerprintIndex([
      nativeUsage({ methodName: 'findPendingByDesk' }),
      nativeUsage({ methodName: 'findPendingByDeskCopy', repositoryName: 'OtherRepository' }),
    ]);

    const matches = matchQueryFingerprint('select * from cash_call where desk_id=?', index);

    expect(matches).toHaveLength(2);
  });

  it('ignores JPQL (non-native) and derived methods', () => {
    const index = buildQueryFingerprintIndex([
      nativeUsage({ isNative: false, queryText: 'SELECT c FROM CashCall c WHERE c.deskId = :d' }),
      nativeUsage({ kind: 'derived_method', queryText: undefined }),
    ]);

    expect(index.size).toBe(0);
    expect(matchQueryFingerprint('select * from cash_call where desk_id=?', index)).toHaveLength(0);
  });

  it('returns no match for unrelated SQL', () => {
    const index = buildQueryFingerprintIndex([nativeUsage({})]);
    expect(matchQueryFingerprint('select * from users where id=?', index)).toHaveLength(0);
  });
});
