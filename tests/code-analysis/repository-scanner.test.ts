import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scanRepositoryUsages } from '../../src/core/code-analysis/repository-scanner';
import { clearJavaSourceCache } from '../../src/core/code-analysis/source-cache';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

function writeRepository(body: string): void {
  const file = path.join(tmpDir, 'src/main/java/com/demo/CashCallRepository.java');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `package com.demo;\n\npublic interface CashCallRepository {\n${body}\n}\n`,
    'utf8',
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1nja-reposcan-test-'));
  clearJavaSourceCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── @Query extraction ────────────────────────────────────────────────────────

describe('scanRepositoryUsages — @Query extraction', () => {
  it('captures a multi-line concatenated native query and its flag', () => {
    writeRepository(`
    @Query(value = "SELECT * FROM cash_call " +
        "WHERE desk_id = :deskId " +
        "AND status = 'PENDING'",
        nativeQuery = true)
    List<CashCall> findPendingByDesk(@Param("deskId") Long deskId);
`);

    const usages = scanRepositoryUsages(tmpDir);
    const query = usages.find((u) => u.kind === 'query_annotation')!;

    expect(query.methodName).toBe('findPendingByDesk');
    expect(query.isNative).toBe(true);
    expect(query.queryText).toBe(
      "SELECT * FROM cash_call WHERE desk_id = :deskId AND status = 'PENDING'",
    );
  });

  it('captures a text-block query', () => {
    writeRepository(`
    @Query(value = """
        SELECT * FROM cash_call
        WHERE desk_id = :deskId
        """, nativeQuery = true)
    List<CashCall> findByDesk(Long deskId);
`);

    const usages = scanRepositoryUsages(tmpDir);
    const query = usages.find((u) => u.kind === 'query_annotation')!;

    expect(query.isNative).toBe(true);
    expect(query.queryText).toContain('SELECT * FROM cash_call');
    expect(query.queryText).toContain('WHERE desk_id = :deskId');
  });

  it('handles nativeQuery declared before value', () => {
    writeRepository(`
    @Query(nativeQuery = true, value = "SELECT COUNT(*) FROM cash_call WHERE desk_id = :d")
    long countByDesk(Long d);
`);

    const usages = scanRepositoryUsages(tmpDir);
    const query = usages.find((u) => u.kind === 'query_annotation')!;

    expect(query.isNative).toBe(true);
    expect(query.queryText).toBe('SELECT COUNT(*) FROM cash_call WHERE desk_id = :d');
    // Scalar return type (no collection wrapper) must still resolve the method.
    expect(query.methodName).toBe('countByDesk');
  });

  it('marks JPQL @Query (no nativeQuery flag) as non-native', () => {
    writeRepository(`
    @Query("SELECT c FROM CashCall c WHERE c.deskId = :deskId")
    List<CashCall> findByDeskJpql(Long deskId);
`);

    const usages = scanRepositoryUsages(tmpDir);
    const query = usages.find((u) => u.kind === 'query_annotation')!;

    expect(query.isNative).toBe(false);
    expect(query.queryText).toBe('SELECT c FROM CashCall c WHERE c.deskId = :deskId');
  });

  it('resolves an inline signature on the same line as the annotation', () => {
    writeRepository(`
    @Query(value = "SELECT * FROM cash_call", nativeQuery = true) List<CashCall> findAllRaw();
`);

    const usages = scanRepositoryUsages(tmpDir);
    const query = usages.find((u) => u.kind === 'query_annotation')!;

    expect(query.methodName).toBe('findAllRaw');
    expect(query.queryText).toBe('SELECT * FROM cash_call');
  });

  it('does not choke on a query built from constants (returns undefined text)', () => {
    writeRepository(`
    @Query(value = BASE_SELECT, nativeQuery = true)
    List<CashCall> findViaConstant();
`);

    const usages = scanRepositoryUsages(tmpDir);
    const query = usages.find((u) => u.kind === 'query_annotation');

    expect(query?.queryText).toBeUndefined();
  });
});
