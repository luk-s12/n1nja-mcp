import * as path from 'path';
import * as fs from 'fs';
import { AnalysisReport } from '../../domain/models/report.model';
import { Issue } from '../../domain/models/issue.model';
import { scanEntities, ScannedEntity } from './entity-scanner';
import { scanAssociationUsages, scanDuplicateRepositoryCalls, scanUnpaginatedRepositoryCalls, scanGenericEntityUsages, scanCartesianJpqlUsages, scanRepositoryMethodCallers, scanLogMessageOrigin, AssociationUsage, CartesianJpqlUsage } from './usage-scanner';
import { scanRepositoryUsages, RepositoryUsage } from './repository-scanner';
import { suggestFixes, FixSuggestion } from './fix-suggester';
import { extractTableName } from '../parsing/sql-normalizer';
import { traceCallChain, CallChain } from './call-chain-tracer';
import { clearJavaSourceCache } from './source-cache';

export interface ProjectFinding {
  /** The original detected issue */
  issue: Issue;
  /** Entity class suspected to be the source */
  suspectedEntity?: ScannedEntity;
  /** Association field suspected to trigger the N+1 */
  suspectedField?: string;
  /** Source code locations where the lazy load is triggered */
  usages: AssociationUsage[];
  /** Repository methods / @Query definitions related to the issue */
  repositoryUsages: RepositoryUsage[];
  /** Repository @Query methods with 2+ JOIN FETCH (Cartesian product root cause) */
  cartesianJpqlUsages?: CartesianJpqlUsage[];
  /** Call chains from HTTP entry point down to the trigger (up to 3) */
  callChains: CallChain[];
  /** Ordered list of fix recommendations */
  fixes: FixSuggestion[];
  /** Human-readable explanation */
  explanation: string;
  /**
   * 'confirmed' — the origin was traced via log message matching (thread context).
   * 'suggested' — the origin is inferred from static code analysis (may include unrelated callers).
   */
  originConfidence: 'confirmed' | 'suggested';
}

export interface ProjectAnalysisResult {
  projectRoot: string;
  analyzedAt: string;
  entitiesScanned: number;
  findingsCount: number;
  findings: ProjectFinding[];
  markdownReport: string;
}

/**
 * Phase 2 analyzer: correlates the detected issues from the log report
 * with the actual Spring Boot project source code.
 */
export function analyzeProjectForNPlusOne(
  projectRoot: string,
  report: AnalysisReport,
): ProjectAnalysisResult {
  const resolvedRoot = resolveProjectRoot(projectRoot, report.summary.logFile);

  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`Project root not found: ${resolvedRoot}`);
  }

  // Fresh read of the project sources for this run; scanners share the cache after this.
  clearJavaSourceCache();

  process.stderr.write(`🥷 Scanning project: ${path.basename(resolvedRoot)}\n`);

  const entities = scanEntities(resolvedRoot);
  process.stderr.write(`✴️  ${entities.length} JPA entit${entities.length === 1 ? 'y' : 'ies'} found\n`);
  const entityByTable = buildEntityTableIndex(entities);

  const findings: ProjectFinding[] = [];

  // Scanned once: the repository catalog doesn't change between issues.
  const repositoryUsages = scanRepositoryUsages(resolvedRoot);

  for (const issue of report.issues) {
    const tableName = extractTableName(issue.query);
    let entity = tableName
      ? entityByTable.get(tableName) ?? findEntityByQuery(entities, issue.query)
      : undefined;

    let suspectedField: string | undefined;
    let usages: AssociationUsage[] = [];
    let cartesianJpqlUsages: CartesianJpqlUsage[] = [];
    let originConfidence: 'confirmed' | 'suggested' = 'suggested';

    // ── Primary: match log INFO messages to source log.info() calls ───────────
    // When the log line "INFO SomeService - [label] message..." precedes the SQL
    // on the same thread, we can confirm exactly which method triggered the query.
    if (issue.threadContextLines?.length) {
      const originMatches = scanLogMessageOrigin(resolvedRoot, issue.threadContextLines);
      if (originMatches.length > 0) {
        usages = originMatches;
        originConfidence = 'confirmed';
      }
    }

    // ── Issue-specific scanners (only when log-context origin not confirmed) ──
    if (originConfidence !== 'confirmed') {
      if (issue.type === 'POSSIBLE_CARTESIAN_PRODUCT') {
        // Find ALL @Query methods with 2+ JOIN FETCH in the project
        const allCartesianJpql = scanCartesianJpqlUsages(resolvedRoot, entity?.className);

        // Match JPQL to the actual SQL in the log by comparing structural features.
        // The log SQL and the JPQL MUST agree on: presence of WHERE clause, presence of DISTINCT.
        cartesianJpqlUsages = matchCartesianJpqlToSql(allCartesianJpql, issue.query);

        // Trace callers only of the matching JPQL method(s)
        for (const jpqlUsage of cartesianJpqlUsages) {
          const callers = scanRepositoryMethodCallers(
            resolvedRoot,
            jpqlUsage.methodName,
            entity?.className,
          );
          usages.push(...callers);
        }

        // Fallback: if no specific callers found, use the generic scan
        if (usages.length === 0 && entity) {
          usages = scanGenericEntityUsages(resolvedRoot, entity.className);
        }
      }

      if (issue.type === 'N_PLUS_1' && entity) {
        const whereColumn = extractWhereColumn(issue.query);
        if (whereColumn) {
          const assoc = entity.associations.find(
            (a) =>
              a.fieldName.toLowerCase().includes(whereColumn.replace(/_id$/, '').toLowerCase()) ||
              whereColumn.includes(a.fieldName.toLowerCase()),
          );
          if (assoc) {
            if (assoc.annotationType === 'ManyToOne' || assoc.annotationType === 'ManyToMany') {
              const parentEntity = entities.find(
                (e) => e.className.toLowerCase() === assoc.targetEntity.toLowerCase(),
              );
              const currentEntityName = entity.className;
              if (parentEntity) {
                const inverseAssoc = parentEntity.associations.find(
                  (a) =>
                    (a.annotationType === 'OneToMany' || a.annotationType === 'ManyToMany') &&
                    a.targetEntity.toLowerCase() === currentEntityName.toLowerCase(),
                );
                if (inverseAssoc) {
                  entity = parentEntity;
                  suspectedField = inverseAssoc.fieldName;
                  usages = scanAssociationUsages(resolvedRoot, parentEntity.className, inverseAssoc.fieldName);
                }
              }
            }

            if (!suspectedField) {
              suspectedField = assoc.fieldName;
              usages = scanAssociationUsages(resolvedRoot, entity.className, assoc.fieldName);
            }
          }
        }
        if (!suspectedField) {
          const lazyCollections = entity.associations.filter(
            (a) =>
              (a.annotationType === 'OneToMany' || a.annotationType === 'ManyToMany') &&
              (a.fetchType === 'LAZY' || a.fetchType === undefined),
          );
          if (lazyCollections.length > 0) {
            suspectedField = lazyCollections[0].fieldName;
            usages = scanAssociationUsages(resolvedRoot, entity.className, lazyCollections[0].fieldName);
          }
        }
      }

      if (issue.type === 'DUPLICATE_QUERY' && entity) {
        const dupEntity = entity;
        usages = scanDuplicateRepositoryCalls(resolvedRoot, dupEntity.className);
        if (usages.length === 0) {
          for (const parentEntity of entities) {
            const matchingAssoc = parentEntity.associations.find(
              (a) => a.targetEntity.toLowerCase() === dupEntity.className.toLowerCase(),
            );
            if (matchingAssoc) {
              suspectedField = matchingAssoc.fieldName;
              const assocUsages = scanAssociationUsages(
                resolvedRoot,
                parentEntity.className,
                matchingAssoc.fieldName,
              );
              usages.push(...assocUsages);
            }
          }
        }
      }

      if (issue.type === 'MISSING_PAGINATION' && entity) {
        usages = scanUnpaginatedRepositoryCalls(resolvedRoot, entity.className);
      }

      // ── Generic fallback for all types when specific scanners find nothing ──
      if (usages.length === 0 && entity) {
        usages = scanGenericEntityUsages(resolvedRoot, entity.className);
      }
    }

    // ── Build fixes, call chains, and push finding ────────────────────────────
    const hasMultipleBagCollections = entity
      ? entity.associations.filter((a) => a.isBag).length >= 2
      : false;

    const loopUsage = usages.find((u) => u.isInsideLoop);
    const fixes = suggestFixes(issue.type, {
      entityName: entity?.className,
      fieldName: suspectedField,
      collectionType:
        entity?.associations.find((a) => a.fieldName === suspectedField)?.annotationType ?? 'unknown',
      isInLoop: loopUsage !== undefined,
      repositoryMethod: usages[0]?.methodName,
      hasMultipleBagCollections,
      usedColumns: issue.type === 'OVER_FETCHING' ? issue.usedColumns : undefined,
    });

    const callChains: CallChain[] = [];
    const tracedMethods = new Set<string>();
    for (const usage of usages.slice(0, 2)) {
      const traceKey = `${usage.className}.${usage.methodName}`;
      if (tracedMethods.has(traceKey)) continue;
      tracedMethods.add(traceKey);
      try {
        const chains = traceCallChain(usage.className, usage.methodName, resolvedRoot);
        callChains.push(...chains);
      } catch {
        // non-fatal
      }
    }

    const relevantRepositoryUsages = selectRelevantRepositoryUsages(
      repositoryUsages,
      issue.query,
      entity,
      suspectedField,
    );

    findings.push({
      issue,
      suspectedEntity: entity,
      suspectedField,
      usages,
      repositoryUsages: relevantRepositoryUsages,
      cartesianJpqlUsages: cartesianJpqlUsages.length > 0 ? cartesianJpqlUsages : undefined,
      callChains,
      fixes,
      explanation: buildExplanation(issue, entity, suspectedField, relevantRepositoryUsages, cartesianJpqlUsages),
      originConfidence,
    });
  }

  const markdownReport = renderProjectMarkdown(resolvedRoot, entities, findings);

  process.stderr.write(`✅ Source analysis done — ${findings.length} finding(s)\n`);

  return {
    projectRoot: resolvedRoot,
    analyzedAt: new Date().toISOString(),
    entitiesScanned: entities.length,
    findingsCount: findings.length,
    findings,
    markdownReport,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Given a list of JPQL methods with 2+ JOIN FETCH and the actual SQL from the log,
 * returns only the JPQL method(s) that structurally match the SQL.
 *
 * Matching uses two signals:
 *  - WHERE presence: SQL with WHERE matches JPQL with WHERE; SQL without WHERE matches JPQL without.
 *  - DISTINCT presence: SQL with DISTINCT matches JPQL with DISTINCT.
 *
 * This prevents tracing callers of "findByIdWithX" when the log shows the bulk
 * "findAllWithX" query (or vice-versa).
 */
function matchCartesianJpqlToSql(
  jpqlUsages: CartesianJpqlUsage[],
  issueSql: string,
): CartesianJpqlUsage[] {
  if (jpqlUsages.length <= 1) return jpqlUsages;

  const sqlLower = issueSql.toLowerCase();
  const sqlHasWhere    = /\bwhere\b/.test(sqlLower);
  const sqlHasDistinct = /\bselect\s+distinct\b/.test(sqlLower);

  const scored = jpqlUsages.map((u) => {
    const jpqlLower     = u.jpqlQuery.toLowerCase();
    const jpqlHasWhere    = /\bwhere\b/.test(jpqlLower);
    const jpqlHasDistinct = /\bdistinct\b/.test(jpqlLower);

    let score = 0;
    if (sqlHasWhere    === jpqlHasWhere)    score += 2;
    if (sqlHasDistinct === jpqlHasDistinct) score += 1;

    return { usage: u, score };
  });

  const maxScore = Math.max(...scored.map((s) => s.score));
  return scored.filter((s) => s.score === maxScore).map((s) => s.usage);
}

function buildEntityTableIndex(entities: ScannedEntity[]): Map<string, ScannedEntity> {
  const map = new Map<string, ScannedEntity>();
  for (const e of entities) {
    if (e.tableName) map.set(e.tableName.toLowerCase(), e);
    map.set(e.className.toLowerCase(), e);
  }
  return map;
}

function resolveProjectRoot(projectRoot: string, logFile?: string): string {
  const requestedRoot = path.resolve(projectRoot);
  const candidates = new Set<string>([requestedRoot]);

  if (logFile) {
    let current = path.resolve(path.dirname(logFile));
    for (let i = 0; i < 5; i++) {
      candidates.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  for (const candidate of candidates) {
    if (looksLikeSpringProjectRoot(candidate)) {
      return candidate;
    }
  }

  return requestedRoot;
}

function looksLikeSpringProjectRoot(root: string): boolean {
  if (!fs.existsSync(root)) return false;
  const srcJava = path.join(root, 'src', 'main', 'java');
  if (fs.existsSync(srcJava)) return true;
  return false;
}

function findEntityByQuery(entities: ScannedEntity[], query: string): ScannedEntity | undefined {
  const lowerQuery = query.toLowerCase();
  return entities.find(
    (e) =>
      lowerQuery.includes(e.className.toLowerCase()) ||
      (e.tableName && lowerQuery.includes(e.tableName.toLowerCase())),
  );
}

function selectRelevantRepositoryUsages(
  repositoryUsages: RepositoryUsage[],
  query: string,
  entity: ScannedEntity | undefined,
  suspectedField: string | undefined,
): RepositoryUsage[] {
  const lowerQuery = query.toLowerCase();
  const entityHints = new Set<string>([
    entity?.className.toLowerCase() ?? '',
    entity?.tableName?.toLowerCase() ?? '',
    suspectedField?.toLowerCase() ?? '',
  ].filter(Boolean));

  return repositoryUsages.filter((usage) => {
    const haystack = `${usage.repositoryName} ${usage.methodName} ${usage.queryText ?? ''} ${usage.codeSnippet.join(' ')}`.toLowerCase();

    if (usage.isJoinFetch) {
      return true;
    }

    if (entityHints.size > 0 && [...entityHints].some((hint) => hint && haystack.includes(hint))) {
      return true;
    }

    return lowerQuery.length > 0 && haystack.includes(lowerQuery.slice(0, Math.min(32, lowerQuery.length)));
  }).slice(0, 6);
}

function extractWhereColumn(sql: string): string | undefined {
  const match = sql.match(/where\s+\w+\.?(\w+)\s*=/i);
  return match ? match[1].toLowerCase() : undefined;
}

function buildExplanation(
  issue: Issue,
  entity: ScannedEntity | undefined,
  field: string | undefined,
  repositoryUsages: RepositoryUsage[] = [],
  cartesianJpqlUsages: CartesianJpqlUsage[] = [],
): string {
  const parts: string[] = [];

  if (issue.type === 'POSSIBLE_CARTESIAN_PRODUCT') {
    const fanOutTables = issue.fanOutTables ?? [];
    if (fanOutTables.length >= 2) {
      parts.push(
        `Cartesian product: joining ${fanOutTables.join(' + ')} on the same parent key ` +
        `produces ${fanOutTables.join(' × ')} SQL rows. ` +
        `Hibernate deduplicates in memory but the DB already transfers all the extra rows.`,
      );
    }
    if (cartesianJpqlUsages.length > 0) {
      const jpqlUsage = cartesianJpqlUsages[0];
      parts.push(
        `Root cause JPQL in \`${jpqlUsage.className}.${jpqlUsage.methodName}()\` ` +
        `(${jpqlUsage.relativeFilePath}:${jpqlUsage.lineNumber}): \`${jpqlUsage.jpqlQuery}\``,
      );
    }
    if (entity) {
      parts.push(`Entity: ${entity.className}.`);
    }
    return parts.join(' ');
  }

  if (issue.type === 'N_PLUS_1') {
    parts.push(`Detected N+1: the query was executed ${issue.executions} times.`);

    if (entity && field) {
      parts.push(`The likely source is the lazy association \`${entity.className}.${field}\`.`);
    }

    const queryUsages = repositoryUsages.filter((u) => u.kind === 'query_annotation' && !u.isJoinFetch);
    const joinFetchFixes = repositoryUsages.filter((u) => u.isJoinFetch);
    if (queryUsages.length > 0) {
      parts.push(`Repository methods without JOIN FETCH: ${queryUsages.map((u) => u.methodName).join(', ')}.`);
    }
    if (joinFetchFixes.length > 0) {
      parts.push(`Existing JOIN FETCH found in: ${joinFetchFixes.map((u) => u.methodName).join(', ')}.`);
    }
  }

  if (issue.type === 'DUPLICATE_QUERY') {
    parts.push(`Duplicate query executed ${issue.executions} times.`);
    if (entity) {
      parts.push(`Likely entity: ${entity.className}.`);
    }
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Markdown renderer for standalone find_n1_in_code usage
// ---------------------------------------------------------------------------

function renderProjectMarkdown(
  projectRoot: string,
  entities: ScannedEntity[],
  findings: ProjectFinding[],
): string {
  const lines: string[] = [];

  lines.push('## Project Source Analysis');
  lines.push('');
  lines.push(`**Project root:** \`${path.basename(projectRoot)}\``);
  lines.push(`**Entities scanned:** ${entities.length}`);
  lines.push('');

  if (findings.length === 0) {
    lines.push('No findings from source code analysis.');
    return lines.join('\n');
  }

  for (const finding of findings) {
    lines.push(`### ${finding.issue.type} — ${finding.issue.severity}`);
    lines.push('');

    if (finding.suspectedEntity) {
      lines.push(`**Entity:** \`${finding.suspectedEntity.className}\``);
      if (finding.suspectedField) {
        lines.push(`**Field:** \`${finding.suspectedField}\``);
      }
      lines.push('');
    }

    if (finding.usages.length > 0) {
      lines.push('**Code locations:**');
      lines.push('');
      lines.push('| File | Line | Method | In Loop |');
      lines.push('|------|------|--------|---------|');
      for (const u of finding.usages.slice(0, 6)) {
        const loopFlag = u.isInsideLoop ? '⚠️ Yes' : 'No';
        lines.push(`| \`${path.basename(u.filePath)}\` | ${u.lineNumber} | \`${u.methodName}()\` | ${loopFlag} |`);
      }
      lines.push('');
    }

    // Show JPQL root cause for Cartesian issues
    if (finding.cartesianJpqlUsages && finding.cartesianJpqlUsages.length > 0) {
      lines.push('**Root cause JPQL (repository):**');
      lines.push('');
      for (const jpqlUsage of finding.cartesianJpqlUsages.slice(0, 2)) {
        lines.push(`\`${jpqlUsage.relativeFilePath}:${jpqlUsage.lineNumber}\` — \`${jpqlUsage.methodName}()\``);
        lines.push('');
        lines.push('```java');
        for (const snippetLine of jpqlUsage.codeSnippet) {
          lines.push(snippetLine);
        }
        lines.push('```');
        lines.push('');
      }
    }

    if (finding.callChains && finding.callChains.length > 0) {
      lines.push('**Request Flow:**');
      lines.push('');
      for (const chain of finding.callChains.slice(0, 2)) {
        lines.push('```');
        for (let si = 0; si < chain.steps.length; si++) {
          const step = chain.steps[si];
          const indent = '  '.repeat(si);
          lines.push(`${indent}-> ${step.className}.${step.methodName}()`);
        }
        lines.push('```');
        lines.push('');
      }
    }

    lines.push(finding.explanation);
    lines.push('');
  }

  return lines.join('\n');
}
