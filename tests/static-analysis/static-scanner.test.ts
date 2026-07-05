import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runStaticScan } from '../../src/core/static-analysis/static-scanner';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

function write(relativePath: string, content: string): void {
  const filePath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

const JAVA = 'src/main/java/com/acme';
const RES = 'src/main/resources';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1nja-static-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EAGER_ENTITY = `package com.acme;

import jakarta.persistence.*;
import java.util.List;

@Entity
@Table(name = "transactions")
public class Transaction {

    @ManyToOne(fetch = FetchType.EAGER)
    private Customer customer;

    @OneToMany(cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.EAGER)
    private List<PaycashToken> tokens;

    @ManyToMany
    private List<Tag> tags;
}
`;

const CLEAN_ENTITY = `package com.acme;

import jakarta.persistence.*;
import java.util.Set;

@Entity
public class Customer {

    @OneToMany(mappedBy = "customer", fetch = FetchType.LAZY)
    private Set<Transaction> transactions;
}
`;

const MULTI_FETCH_REPO = `package com.acme;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface CustomerRepository extends JpaRepository<Customer, Long> {

    @Query("SELECT c FROM Customer c " +
           "LEFT JOIN FETCH c.transactions t " +
           "LEFT JOIN FETCH c.addresses a " +
           "WHERE c.id = :id")
    Optional<Customer> findFullById(Long id);

    @Query("SELECT c FROM Customer c LEFT JOIN FETCH c.transactions WHERE c.id = :id")
    Optional<Customer> findWithTransactions(Long id);
}
`;

const SERVICE = `package com.acme;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class CustomerService {

    private final CustomerRepository customerRepository;

    @Transactional
    public List<Customer> findAllCustomers() {
        return customerRepository.findAll();
    }

    @Transactional
    public void importAll(List<Customer> batch) {
        customerRepository.saveAll(batch);
    }

    @Transactional(readOnly = true)
    public Customer getOne(Long id) {
        return customerRepository.findById(id).orElseThrow();
    }
}
`;

function writeProject(root: string): void {
  const j = path.join(root, JAVA);
  const r = path.join(root, RES);
  fs.mkdirSync(path.join(tmpDir, j), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, r), { recursive: true });
  write(`${root}/${JAVA}/Transaction.java`, EAGER_ENTITY);
  write(`${root}/${JAVA}/Customer.java`, CLEAN_ENTITY);
  write(`${root}/${JAVA}/CustomerRepository.java`, MULTI_FETCH_REPO);
  write(`${root}/${JAVA}/CustomerService.java`, SERVICE);
  write(`${root}/${RES}/application.yml`, 'spring:\n  application:\n    name: demo\n');
}

// ── Single-project mode ───────────────────────────────────────────────────────

describe('runStaticScan — single project', () => {
  beforeEach(() => writeProject('.'));

  it('detects every anti-pattern in the fixture project', () => {
    const result = runStaticScan(tmpDir);

    expect(result.mode).toBe('single');
    expect(result.projects).toHaveLength(1);
    const types = result.projects[0].findings.map((f) => f.type);

    expect(types).toContain('EAGER_COLLECTION');       // Transaction.tokens
    expect(types).toContain('EAGER_TO_ONE');           // Transaction.customer
    expect(types).toContain('MANY_TO_MANY');           // Transaction.tags
    expect(types).toContain('MULTIPLE_JOIN_FETCH');    // findFullById (2 fetches)
    expect(types).toContain('UNBOUNDED_FIND_ALL');     // findAllCustomers
    expect(types).toContain('SAVE_ALL_WITHOUT_BATCH_SIZE'); // importAll
    expect(types).toContain('TRANSACTIONAL_NOT_READ_ONLY'); // findAllCustomers
  });

  it('reports file, line and severity for the EAGER collection', () => {
    const result = runStaticScan(tmpDir);
    const eager = result.projects[0].findings.find((f) => f.type === 'EAGER_COLLECTION')!;

    expect(eager.severity).toBe('HIGH');
    expect(eager.file).toBe(`${JAVA}/Transaction.java`);
    expect(eager.line).toBeGreaterThan(0);
    expect(eager.detail).toContain('Transaction.tokens');
  });

  it('does not flag the single-fetch query or the readOnly method', () => {
    const result = runStaticScan(tmpDir);
    const findings = result.projects[0].findings;

    const multiFetch = findings.filter((f) => f.type === 'MULTIPLE_JOIN_FETCH');
    expect(multiFetch).toHaveLength(1); // findWithTransactions (1 fetch) not flagged

    const txFindings = findings.filter((f) => f.type === 'TRANSACTIONAL_NOT_READ_ONLY');
    expect(txFindings.every((f) => !f.detail.includes('getOne'))).toBe(true);
  });

  it('skips SAVE_ALL_WITHOUT_BATCH_SIZE when batch_size is configured', () => {
    write(
      `${RES}/application.yml`,
      'spring:\n  jpa:\n    properties:\n      hibernate:\n        jdbc:\n          batch_size: 30\n',
    );

    const result = runStaticScan(tmpDir);
    const types = result.projects[0].findings.map((f) => f.type);
    expect(types).not.toContain('SAVE_ALL_WITHOUT_BATCH_SIZE');
  });

  it('sorts findings most-severe first and computes the score', () => {
    const result = runStaticScan(tmpDir);
    const p = result.projects[0];

    expect(p.findings[0].severity).toBe('HIGH');
    // HIGH=5, MEDIUM=2, LOW=1 — score must equal the weighted sum.
    const expected = p.findings.reduce(
      (acc, f) => acc + ({ HIGH: 5, MEDIUM: 2, LOW: 1 } as const)[f.severity],
      0,
    );
    expect(p.score).toBe(expected);
  });
});

// ── Fleet mode ────────────────────────────────────────────────────────────────

describe('runStaticScan — fleet mode', () => {
  it('scans every subproject and ranks worst first', () => {
    writeProject('ms-dirty');
    // A clean service: one lazy entity, nothing else.
    write(`ms-clean/${JAVA}/Customer.java`, CLEAN_ENTITY);
    // Noise: a non-Java folder that must be ignored.
    write('docs/readme.txt', 'not a project');

    const result = runStaticScan(tmpDir);

    expect(result.mode).toBe('fleet');
    expect(result.projects.map((p) => p.projectName)).toEqual(['ms-dirty', 'ms-clean']);
    expect(result.projects[0].score).toBeGreaterThan(result.projects[1].score);
    expect(result.projects[1].findings).toHaveLength(0);
    expect(result.markdownReport).toContain('Ranking (worst first)');
  });

  it('throws a clear error when nothing scannable exists', () => {
    write('docs/readme.txt', 'not a project');
    expect(() => runStaticScan(tmpDir)).toThrow(/not a Java project/);
  });

  it('respects maxFindingsPerProject', () => {
    writeProject('ms-dirty');
    const result = runStaticScan(tmpDir, { maxFindingsPerProject: 2 });
    expect(result.projects[0].findings).toHaveLength(2);
    // The cap keeps the most severe ones.
    expect(result.projects[0].findings[0].severity).toBe('HIGH');
  });
});
