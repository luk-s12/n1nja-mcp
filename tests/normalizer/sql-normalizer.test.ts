import { normalizeSql, extractTableName, countJoins, lacksPagination, isSelectQuery } from '../../src/core/parsing/sql-normalizer';

describe('normalizeSql', () => {
  it('replaces numeric literals with ?', () => {
    expect(normalizeSql('select * from member where group_id=1')).toBe(
      'select * from member where group_id=?',
    );
    expect(normalizeSql('select * from member where group_id=456')).toBe(
      'select * from member where group_id=?',
    );
  });

  it('normalizes different numeric values to the same form', () => {
    const a = normalizeSql('select * from member where group_id=1');
    const b = normalizeSql('select * from member where group_id=2');
    expect(a).toBe(b);
  });

  it('replaces UUID literals with ?', () => {
    const sql = "select * from user where id='550e8400-e29b-41d4-a716-446655440000'";
    expect(normalizeSql(sql)).toBe('select * from user where id=?');
  });

  it('replaces quoted string literals with ?', () => {
    const a = normalizeSql("select * from member where name='Alice'");
    const b = normalizeSql("select * from member where name='Bob'");
    expect(a).toBe(b);
    expect(a).toBe('select * from member where name=?');
  });

  it('replaces timestamp literals with ?', () => {
    const sql = "select * from event where created_at='2024-01-15T10:30:00'";
    expect(normalizeSql(sql)).toContain('?');
  });

  it('collapses IN lists to (?)', () => {
    const sql = 'select * from tag where id in (1, 2, 3)';
    const normalized = normalizeSql(sql);
    expect(normalized).toContain('(?)');
  });

  it('lowercases the result', () => {
    const sql = 'SELECT * FROM User WHERE Id=1';
    expect(normalizeSql(sql)).toBe('select * from user where id=?');
  });

  it('collapses extra whitespace', () => {
    const sql = 'select  *   from  member   where   id=1';
    expect(normalizeSql(sql)).toBe('select * from member where id=?');
  });

  it('handles multi-condition WHERE', () => {
    const a = normalizeSql("select * from order where user_id=10 and status='ACTIVE'");
    const b = normalizeSql("select * from order where user_id=99 and status='PENDING'");
    expect(a).toBe(b);
  });
});

describe('extractTableName', () => {
  it('extracts simple table name', () => {
    expect(extractTableName('select * from member where id=1')).toBe('member');
  });

  it('returns null for non-SELECT', () => {
    expect(extractTableName('update member set name=?')).toBeNull();
  });
});

describe('countJoins', () => {
  it('counts LEFT JOINs', () => {
    const sql = 'select * from a left join b on a.id=b.a_id left join c on a.id=c.a_id';
    expect(countJoins(sql)).toBe(2);
  });

  it('returns 0 for no joins', () => {
    expect(countJoins('select * from member')).toBe(0);
  });
});

describe('lacksPagination', () => {
  it('returns true when no LIMIT', () => {
    expect(lacksPagination('select * from member')).toBe(true);
  });

  it('returns false when LIMIT present', () => {
    expect(lacksPagination('select * from member limit 20')).toBe(false);
  });

  it('returns false when FETCH FIRST present', () => {
    expect(lacksPagination('select * from member fetch first 10 rows only')).toBe(false);
  });
});

describe('isSelectQuery', () => {
  it('identifies SELECT queries', () => {
    expect(isSelectQuery('select * from member')).toBe(true);
    expect(isSelectQuery('  SELECT id FROM users')).toBe(true);
  });

  it('rejects non-SELECT', () => {
    expect(isSelectQuery('update member set name=?')).toBe(false);
    expect(isSelectQuery('insert into member values (?)')).toBe(false);
  });
});
