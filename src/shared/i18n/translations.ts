/**
 * N1nja MCP — Internationalization strings (English / Español)
 */

export type Lang = 'en' | 'es';

export interface LangStrings {
  // ── Detector descriptions & recommendations ───────────────────────────────
  detectors: {
    nPlusOne: {
      description: (count: number) => string;
      recommendation: string;
    };
    duplicateQuery: {
      description: (count: number) => string;
      descriptionPerRequest: (count: number, thread?: string) => string;
      recommendation: string;
    };
    missingPagination: {
      description: string;
      recommendation: string;
    };
    largeResultSet: {
      description: (rows: number, executions: number, threshold: number) => string;
      recommendation: string;
    };
    slowQuery: {
      description: (threshold: number, max: number, avg: number) => string;
      recommendation: string;
      timingDetected: (ms: number) => string;
    };
    slowQueryPattern: {
      description: (reason: string) => string;
      recommendation: string;
      timingHint: string;
      timingHintMethod: (file: string, method: string) => string;
    };
    cartesianProduct: {
      description: (joinCount: number, tables?: string[]) => string;
      recommendation: string;
    };
    overFetching: {
      description: (uniqueQueries: number, totalExecutions: number) => string;
      descriptionColumns: (entity: string, unused: string[], used: string[]) => string;
      recommendation: string;
    };
    deadlock: {
      description: (occurrences: number) => string;
      recommendation: string;
      queriesLabel: string;
      queryNotFound: string;
    };
  };

  // ── Markdown reporter ─────────────────────────────────────────────────────
  report: {
    title: string;
    labelLogFile: string;
    labelAnalyzedAt: string;
    labelLinesProcessed: string;
    sectionSummary: string;
    sectionIssues: string;
    sectionStatistics: string;
    sectionTopQueries: string;
    noIssues: string;
    colMetric: string;
    colValue: string;
    colExecutions: string;
    colAvgTime: string;
    colQuery: string;
    metricTotalQueries: string;
    metricUniqueQueries: string;
    metricDetectedIssues: string;
    metricExecutionTime: string;
    metricHighSeverity: string;
    metricMediumSeverity: string;
    metricLowSeverity: string;
    labelDescription: string;
    labelNormalizedQuery: string;
    labelEvidence: string;
    labelRecommendation: string;
    labelExecutions: string;
    labelExtraQueries: string;
    labelTriggeredAfter: string;
    labelTotalRows: string;
    labelMaxExecTime: string;
    labelJoinCount: string;
  };

  // ── generate_n1_report headers ────────────────────────────────────────────
  generateReport: {
    title: string;
    labelGenerated: string;
    labelLogFile: string;
    labelLinesProcessed: string;
    labelAnalysisTime: string;
    sectionSummary: string;
    sectionIssues: string;
    sectionProjectScan: string;
    noIssues: string;
    colMetric: string;
    colValue: string;
    metricTotalQueries: string;
    metricUniquePatterns: string;
    metricIssuesFound: string;
    metricEntitiesScanned: string;
    metricFindingsWithCode: string;
    labelSeverity: string;
    labelSqlPattern: string;
    labelOccurrences: string;
    labelEvidence: (n: number) => string;
    labelEntity: string;
    labelField: string;
    labelNativeQueryMatch: string;
    matchExact: string;
    matchPaginated: string;
    labelOriginCode: string;
    labelSuggestedOriginCode: string;
    colFile: string;
    colLine: string;
    colMethod: string;
    colInLoop: string;
    loopWarning: (n: number) => string;
    noCodeLocation: string;
    labelFixOptions: string;
    labelRecommended: string;
    labelSuggestedFix: string;
    footer: string;
    issueTypes: string;
    flowSection: string;
    codeLabel: Record<string, string>;
    codeLabelDefault: string;
    triggerLabel: Record<string, string>;
    triggerLabelDefault: string;
  };

  // ── Fix suggester ─────────────────────────────────────────────────────────
  fixes: {
    joinFetch: { description: (entity: string, field: string) => string };
    entityGraph: { description: (entity: string, field: string) => string };
    batchFetching: { description: (entity: string, field: string) => string };
    dtoProjection: { description: (entity: string, field: string) => string };
    cache: { description: (method: string) => string };
    batchFind: { description: string };
    pagination: { description: (entity: string) => string };
    index: { description: string };
    dtoSlim: { description: (entity: string) => string };
  };
}

// ── English ───────────────────────────────────────────────────────────────────

export const EN: LangStrings = {
  detectors: {
    nPlusOne: {
      description: (count) =>
        `Query executed ${count} times with only parameter values changing — classic N+1 pattern.`,
      recommendation:
        'Consider using JOIN FETCH, @EntityGraph, DTO projections with a single JOIN query, ' +
        'or Hibernate Batch Fetching (@BatchSize / hibernate.default_batch_fetch_size).',
    },
    duplicateQuery: {
      description: (count) =>
        `The same query was executed ${count} times. This may indicate a missing cache, ` +
        'redundant repository calls, or a loop calling a finder method individually.',
      descriptionPerRequest: (count, thread) =>
        `The same query was fired ${count}× within a single request` +
        (thread ? ` (thread: ${thread})` : '') +
        '. The entity was loaded once but the result was not reused — each call wastes a DB round-trip.',
      recommendation:
        'Consider adding Spring Cache (@Cacheable) on the repository method, ' +
        'or refactoring to use a batch find (findAllById) and process results in memory.',
    },
    missingPagination: {
      description:
        'This query fetches all rows without pagination. On large tables this can cause ' +
        'out-of-memory errors and severe performance degradation.',
      recommendation:
        'Add Spring Data Pageable parameter to the repository method and use Page<T> / Slice<T> return types. ' +
        'In JPQL, add LIMIT/OFFSET or use setMaxResults() on the Query object.',
    },
    largeResultSet: {
      description: (rows, executions, threshold) =>
        `This query returned a total of ${rows} rows across ${executions} execution(s), ` +
        `which exceeds the threshold of ${threshold}.`,
      recommendation:
        'Add pagination (Pageable / LIMIT), apply stricter WHERE filters, ' +
        'or use DTO projections to select only required columns.',
    },
    slowQuery: {
      description: (threshold, max, avg) =>
        `Query exceeded slow-query threshold of ${threshold}ms. Max observed: ${max}ms, avg: ${avg}ms.`,
      recommendation:
        'Analyze the query execution plan (EXPLAIN ANALYZE). ' +
        'Consider adding database indexes, refactoring the query, or using read replicas.',
      timingDetected: (ms) => `Measured timing found in the log: ${ms}ms.`,
    },
    slowQueryPattern: {
      description: (reason) =>
        `SQL anti-pattern detected that forces a full table scan or prevents index use: ${reason}.`,
      recommendation:
        'Avoid applying functions on indexed columns in WHERE clauses (LOWER, UPPER, DATE, CAST, etc.). ' +
        'Use a functional index, a generated column, or restructure the query so the column appears bare. ' +
        'For LIKE searches, prefer full-text search (PostgreSQL tsvector / MySQL FULLTEXT) or a dedicated search engine.',
      timingHint:
        '💡 **Para mayor precision:** N1nja detecto esta consulta por analisis estatico del SQL. ' +
        'Para medir el tiempo real agrega los siguientes logs en tu servicio:',
      timingHintMethod: (file, method) =>
        `Agrega en \`${file}\` dentro de \`${method}()\`, antes y despues de la llamada al repositorio:`,
    },
    cartesianProduct: {
      description: (joinCount, tables) =>
        tables && tables.length >= 2
          ? `Fan-out JOIN detected: the same parent key is joined to ${tables.length} sibling collections ` +
            `(${tables.join(', ')}). SQL rows = ${tables.join(' × ')} — Hibernate deduplicates in memory ` +
            `but the DB already transfers all the extra rows.`
          : `Query uses ${joinCount} JOINs without DISTINCT, which may produce a cartesian product ` +
            'and multiply the returned rows unexpectedly.',
      recommendation:
        'Never JOIN FETCH two sibling collections in the same query. ' +
        'Use @BatchSize on each collection (2 IN-queries instead of a Cartesian explosion), ' +
        'or load one collection with JOIN FETCH / @EntityGraph and the other with a separate query.',
    },
    overFetching: {
      description: (uniqueQueries, totalExecutions) =>
        `Found ${uniqueQueries} unique query pattern(s) using SELECT * executed ${totalExecutions} time(s). ` +
        'Loading all columns wastes memory and network bandwidth when only a few fields are needed.',
      descriptionColumns: (entity, unused, used) =>
        `The query loads the full ${entity} row but the triggering method only reads ${used.join(', ')}. ` +
        `Column(s) ${unused.join(', ')} are fetched and discarded on every row — ` +
        'use a DTO/interface projection to select only the fields you need.',
      recommendation:
        'Replace SELECT * with explicit column lists using DTO/interface projections. ' +
        'In Spring Data, use interface-based projections or @Query with a constructor expression: ' +
        'SELECT new com.example.dto.UserDto(u.id, u.name) FROM User u.',
    },
    deadlock: {
      description: (occurrences) =>
        `Detected ${occurrences} lock/deadlock error(s) in the log. ` +
        'Transactions are competing for the same rows and timing out or rolling back.',
      recommendation:
        'Review transaction boundaries (@Transactional scope). ' +
        'Ensure consistent lock ordering across transactions. ' +
        'Consider shorter transactions, optimistic locking (@Version), ' +
        'or SELECT ... FOR UPDATE SKIP LOCKED for queue-style workloads.',
      queriesLabel: '**Queries involved:**',
      queryNotFound:
        '_No SQL statement could be recovered from the log for this deadlock — ' +
        'enable SQL logging (org.hibernate.SQL) or log the offending statement to pinpoint it._',
    },
  },

  report: {
    title: '# Hibernate N+1 Analysis Report',
    labelLogFile: '**Log file:**',
    labelAnalyzedAt: '**Analyzed:**',
    labelLinesProcessed: '**Lines processed:**',
    sectionSummary: '## Summary',
    sectionIssues: '## Detected Issues',
    sectionStatistics: '## Hibernate Statistics',
    sectionTopQueries: '## Top Queries by Execution Count',
    noIssues: '> ✅ No performance issues detected.',
    colMetric: 'Metric',
    colValue: 'Value',
    colExecutions: 'Executions',
    colAvgTime: 'Avg Time (ms)',
    colQuery: 'Query',
    metricTotalQueries: 'Total queries executed',
    metricUniqueQueries: 'Unique normalized queries',
    metricDetectedIssues: 'Issues detected',
    metricExecutionTime: 'Total execution time',
    metricHighSeverity: '🔴 HIGH severity issues',
    metricMediumSeverity: '🟡 MEDIUM severity issues',
    metricLowSeverity: '🟢 LOW severity issues',
    labelDescription: '**Description:**',
    labelNormalizedQuery: '**Normalized Query:**',
    labelEvidence: '**Evidence (raw log samples):**',
    labelRecommendation: '**Recommendation:**',
    labelExecutions: '**Executions:**',
    labelExtraQueries: '**Estimated extra queries:**',
    labelTriggeredAfter: '**Triggered after:**',
    labelTotalRows: '**Total rows returned:**',
    labelMaxExecTime: '**Max execution time:**',
    labelJoinCount: '**JOIN count:**',
  },

  generateReport: {
    title: '# 🥷 N1nja Report',
    labelGenerated: '**Generated:**',
    labelLogFile: '**Log file:**',
    labelLinesProcessed: '**Lines processed:**',
    labelAnalysisTime: '**Analysis time:**',
    sectionSummary: '## 📊 Summary',
    sectionIssues: '## 🐛 Issues & Fixes',
    sectionProjectScan: '## 🗂️ Project Scan',
    noIssues: '> ✅ No issues detected. Your queries look clean!',
    colMetric: 'Metric',
    colValue: 'Value',
    metricTotalQueries: 'Total queries executed',
    metricUniquePatterns: 'Unique query patterns',
    metricIssuesFound: 'Issues detected',
    metricEntitiesScanned: 'JPA entities scanned',
    metricFindingsWithCode: 'Findings with code location',
    labelSeverity: '**Severity:**',
    labelSqlPattern: '**SQL pattern:**',
    labelOccurrences: '**Occurrences:**',
    labelEvidence: (n) => `Evidence from log (${n} sample${n !== 1 ? 's' : ''})`,
    labelEntity: '**Entity:**',
    labelField: '→ field',
    labelNativeQueryMatch: '**🎯 Native @Query match (SQL fingerprint):**',
    matchExact: 'exact match',
    matchPaginated: 'match (paginated by Pageable)',
    labelOriginCode: '**📍 Origin in source code (confirmed from log):**',
    labelSuggestedOriginCode: '**🔍 Possible origin in source code (suggested — log context not matched):**',
    colFile: 'File',
    colLine: 'Line',
    colMethod: 'Method',
    colInLoop: 'In Loop',
    loopWarning: (n) => `⚠️ **${n} access${n > 1 ? 'es' : ''} inside a loop** — this is the direct cause of the N+1.`,
    noCodeLocation: '> *No specific code location found — issue detected from log patterns only.*',
    labelFixOptions: '**🔧 Fix options:**',
    labelRecommended: '*(Recommended)*',
    labelSuggestedFix: '**🔧 Suggested fix:**',
    footer: '*Generated by [N1nja MCP](https://github.com/luk-s12/n1nja-mcp) — Hibernate N+1 detector*',
    issueTypes: '**Issue types:**',
    flowSection: '**🔗 Request flow that triggers it:**',
    codeLabel: {
      DUPLICATE_QUERY: '⚠️ Method with redundant repository calls:',
      MISSING_PAGINATION: '⚠️ Method loading all rows with no pagination:',
      SLOW_QUERY: '⚠️ Code running this slow query:',
      LARGE_RESULT_SET: '⚠️ Code loading this unfiltered result set:',
      OVER_FETCHING: '⚠️ Code fetching columns it never uses (over-fetching):',
      POSSIBLE_CARTESIAN_PRODUCT: '⚠️ Code triggering the cartesian product:',
      DEADLOCK: '⚠️ Transaction taking part in the deadlock:',
    },
    codeLabelDefault: '⚠️ Code triggering this issue:',
    triggerLabel: {
      N_PLUS_1: '🔴 N+1 fires here',
      DUPLICATE_QUERY: '🔴 duplicate query here',
      MISSING_PAGINATION: '🔴 unpaginated load here',
      LARGE_RESULT_SET: '🔴 massive result set here',
      SLOW_QUERY: '🔴 slow query here',
      OVER_FETCHING: '🔴 over-fetching here',
      POSSIBLE_CARTESIAN_PRODUCT: '🔴 cartesian product here',
      DEADLOCK: '🔴 deadlock fires here',
    },
    triggerLabelDefault: '🔴 issue fires here',
  },

  fixes: {
    joinFetch: {
      description: (_entity, field) =>
        `Add JOIN FETCH in the JPQL query to load ${field} in a single SQL statement.`,
    },
    entityGraph: {
      description: (_entity, field) =>
        `Use @EntityGraph to specify ${field} as an eagerly-fetched association without modifying JPQL.`,
    },
    batchFetching: {
      description: (_entity, field) =>
        `Configure Hibernate batch fetching to load ${field} in batches instead of one-by-one.`,
    },
    dtoProjection: {
      description: (_entity, _field) =>
        `Use a DTO projection with a single JOIN query to avoid loading full entities.`,
    },
    cache: {
      description: (method) =>
        `Cache the result of ${method} using Spring Cache.`,
    },
    batchFind: {
      description: 'If called in a loop, replace individual findById() calls with findAllById().',
    },
    pagination: {
      description: (entity) =>
        `Add Pageable parameter to the repository method and return Page<${entity}>.`,
    },
    index: {
      description: 'Add a database index on the columns used in the WHERE / ORDER BY clause.',
    },
    dtoSlim: {
      description: (_entity) =>
        `Use an interface or class projection to SELECT only needed columns.`,
    },
  },
};

// ── Espanol ───────────────────────────────────────────────────────────────────

export const ES: LangStrings = {
  detectors: {
    nPlusOne: {
      description: (count) =>
        `La consulta se ejecuto ${count} veces cambiando solo los parametros - patron N+1 clasico.`,
      recommendation:
        'Considera usar JOIN FETCH, @EntityGraph, proyecciones DTO con una sola consulta JOIN, ' +
        'o Hibernate Batch Fetching (@BatchSize / hibernate.default_batch_fetch_size).',
    },
    duplicateQuery: {
      description: (count) =>
        `La misma consulta se ejecuto ${count} veces. Puede indicar una cache faltante, ` +
        'llamadas redundantes al repositorio, o un loop llamando a un finder individualmente.',
      descriptionPerRequest: (count, thread) =>
        `La misma consulta se disparo ${count} veces dentro de una sola request` +
        (thread ? ` (thread: ${thread})` : '') +
        '. La entidad se cargo una vez pero el resultado no se reutilizo — cada llamada extra desperdicia un round-trip a la BD.',
      recommendation:
        'Considera agregar Spring Cache (@Cacheable) en el metodo del repositorio, ' +
        'o refactorizar para usar findAllById() y procesar los resultados en memoria.',
    },
    missingPagination: {
      description:
        'Esta consulta trae todas las filas sin paginacion. En tablas grandes puede causar ' +
        'errores de memoria y degradacion severa del rendimiento.',
      recommendation:
        'Agrega el parametro Pageable al metodo del repositorio y usa Page<T> / Slice<T> como tipo de retorno. ' +
        'En JPQL, agrega LIMIT/OFFSET o usa setMaxResults() en el objeto Query.',
    },
    largeResultSet: {
      description: (rows, executions, threshold) =>
        `Esta consulta devolvio ${rows} filas en total en ${executions} ejecucion(es), ` +
        `superando el umbral de ${threshold}.`,
      recommendation:
        'Agrega paginacion (Pageable / LIMIT), aplica filtros WHERE mas estrictos, ' +
        'o usa proyecciones DTO para seleccionar solo las columnas necesarias.',
    },
    slowQuery: {
      description: (threshold, max, avg) =>
        `La consulta supero el umbral de consulta lenta de ${threshold}ms. Maximo observado: ${max}ms, promedio: ${avg}ms.`,
      recommendation:
        'Analiza el plan de ejecucion de la consulta (EXPLAIN ANALYZE). ' +
        'Considera agregar indices en la base de datos, refactorizar la consulta, o usar replicas de lectura.',
      timingDetected: (ms) => `Se encontro el timing medido en el log: ${ms}ms.`,
    },
    slowQueryPattern: {
      description: (reason) =>
        `Patron SQL detectado que fuerza un full table scan o impide el uso de indices: ${reason}.`,
      recommendation:
        'Evita aplicar funciones sobre columnas indexadas en clausulas WHERE (LOWER, UPPER, DATE, CAST, etc.). ' +
        'Usa un indice funcional, una columna generada, o reestructura la consulta para que la columna aparezca sin funcion. ' +
        'Para busquedas LIKE, considera full-text search (PostgreSQL tsvector / MySQL FULLTEXT) o un motor de busqueda dedicado.',
      timingHint:
        '💡 **Para mayor precision:** N1nja detecto esta consulta por analisis estatico del SQL. ' +
        'Para medir el tiempo real agrega los siguientes logs en tu servicio:',
      timingHintMethod: (file, method) =>
        `Agrega en \`${file}\` dentro de \`${method}()\`, antes y despues de la llamada al repositorio:`,
    },
    cartesianProduct: {
      description: (joinCount, tables) =>
        tables && tables.length >= 2
          ? `JOIN fan-out detectado: la misma clave padre se une a ${tables.length} colecciones hermanas ` +
            `(${tables.join(', ')}). Filas SQL = ${tables.join(' × ')} — Hibernate deduplica en memoria ` +
            `pero la BD ya transfiere todas las filas extra.`
          : `La consulta usa ${joinCount} JOINs sin DISTINCT, lo que puede producir un producto cartesiano ` +
            'y multiplicar las filas retornadas inesperadamente.',
      recommendation:
        'Nunca hagas JOIN FETCH a dos colecciones hermanas en la misma consulta. ' +
        'Usa @BatchSize en cada coleccion (2 queries IN en lugar de una explosion cartesiana), ' +
        'o carga una coleccion con JOIN FETCH / @EntityGraph y la otra con una consulta separada.',
    },
    overFetching: {
      description: (uniqueQueries, totalExecutions) =>
        `Se encontraron ${uniqueQueries} patron(es) unico(s) usando SELECT * ejecutados ${totalExecutions} vez/veces. ` +
        'Cargar todas las columnas desperdicia memoria y ancho de banda cuando solo se necesitan algunos campos.',
      descriptionColumns: (entity, unused, used) =>
        `La consulta carga la fila completa de ${entity} pero el metodo solo usa ${used.join(', ')}. ` +
        `La(s) columna(s) ${unused.join(', ')} se traen y se descartan en cada fila — ` +
        'usa una proyeccion DTO/interfaz para traer solo los campos que necesitas.',
      recommendation:
        'Reemplaza SELECT * con listas de columnas explicitas usando proyecciones DTO/interfaz. ' +
        'En Spring Data, usa proyecciones basadas en interfaz o @Query con expresion de constructor: ' +
        'SELECT new com.example.dto.UserDto(u.id, u.name) FROM User u.',
    },
    deadlock: {
      description: (occurrences) =>
        `Se detectaron ${occurrences} error(es) de lock/deadlock en el log. ` +
        'Las transacciones compiten por las mismas filas y estan haciendo timeout o rollback.',
      recommendation:
        'Revisa los limites de transacciones (@Transactional). ' +
        'Asegurate de tener un orden de locks consistente entre transacciones. ' +
        'Considera transacciones mas cortas, locking optimista (@Version), ' +
        'o SELECT ... FOR UPDATE SKIP LOCKED para workloads tipo cola.',
      queriesLabel: '**Queries involucradas:**',
      queryNotFound:
        '_No se pudo recuperar ninguna sentencia SQL del log para este deadlock — ' +
        'activa el logging de SQL (org.hibernate.SQL) o loguea la sentencia culpable para identificarla._',
    },
  },

  report: {
    title: '# Reporte de Analisis Hibernate N+1',
    labelLogFile: '**Archivo de log:**',
    labelAnalyzedAt: '**Analizado:**',
    labelLinesProcessed: '**Lineas procesadas:**',
    sectionSummary: '## Resumen',
    sectionIssues: '## Problemas Detectados',
    sectionStatistics: '## Estadisticas de Hibernate',
    sectionTopQueries: '## Top Consultas por Cantidad de Ejecuciones',
    noIssues: '> ✅ No se detectaron problemas de rendimiento.',
    colMetric: 'Metrica',
    colValue: 'Valor',
    colExecutions: 'Ejecuciones',
    colAvgTime: 'Tiempo Prom. (ms)',
    colQuery: 'Consulta',
    metricTotalQueries: 'Total de consultas ejecutadas',
    metricUniqueQueries: 'Consultas normalizadas unicas',
    metricDetectedIssues: 'Problemas detectados',
    metricExecutionTime: 'Tiempo total de analisis',
    metricHighSeverity: '🔴 Problemas de severidad ALTA',
    metricMediumSeverity: '🟡 Problemas de severidad MEDIA',
    metricLowSeverity: '🟢 Problemas de severidad BAJA',
    labelDescription: '**Descripcion:**',
    labelNormalizedQuery: '**Consulta Normalizada:**',
    labelEvidence: '**Evidencia (muestras del log):**',
    labelRecommendation: '**Recomendacion:**',
    labelExecutions: '**Ejecuciones:**',
    labelExtraQueries: '**Consultas extra estimadas:**',
    labelTriggeredAfter: '**Disparado por:**',
    labelTotalRows: '**Total de filas retornadas:**',
    labelMaxExecTime: '**Tiempo maximo de ejecucion:**',
    labelJoinCount: '**Cantidad de JOINs:**',
  },

  generateReport: {
    title: '# 🥷 Reporte N1nja',
    labelGenerated: '**Generado:**',
    labelLogFile: '**Archivo de log:**',
    labelLinesProcessed: '**Lineas procesadas:**',
    labelAnalysisTime: '**Tiempo de analisis:**',
    sectionSummary: '## 📊 Resumen',
    sectionIssues: '## 🐛 Problemas y Soluciones',
    sectionProjectScan: '## 🗂️ Escaneo del Proyecto',
    noIssues: '> ✅ No se detectaron problemas. Tus consultas se ven bien!',
    colMetric: 'Metrica',
    colValue: 'Valor',
    metricTotalQueries: 'Total de consultas ejecutadas',
    metricUniquePatterns: 'Patrones unicos de consulta',
    metricIssuesFound: 'Problemas detectados',
    metricEntitiesScanned: 'Entidades JPA escaneadas',
    metricFindingsWithCode: 'Hallazgos con ubicacion en codigo',
    labelSeverity: '**Severidad:**',
    labelSqlPattern: '**Patron SQL:**',
    labelOccurrences: '**Ocurrencias:**',
    labelEvidence: (n) => `Evidencia del log (${n} muestra${n !== 1 ? 's' : ''})`,
    labelEntity: '**Entidad:**',
    labelField: '-> campo',
    labelNativeQueryMatch: '**🎯 Match de @Query nativa (huella SQL):**',
    matchExact: 'match exacto',
    matchPaginated: 'match (paginada por Pageable)',
    labelOriginCode: '**📍 Origen en el codigo fuente (confirmado desde el log):**',
    labelSuggestedOriginCode: '**🔍 Posible origen en el codigo fuente (sugerido — contexto del log no encontrado):**',
    colFile: 'Archivo',
    colLine: 'Linea',
    colMethod: 'Metodo',
    colInLoop: 'En Loop',
    loopWarning: (n) => `⚠️ **${n} acceso${n > 1 ? 's' : ''} dentro de un loop** - esta es la causa directa del N+1.`,
    noCodeLocation: '> *No se encontro una ubicacion especifica en el codigo - problema detectado solo desde los patrones del log.*',
    labelFixOptions: '**🔧 Opciones de solucion:**',
    labelRecommended: '*(Recomendado)*',
    labelSuggestedFix: '**🔧 Solucion sugerida:**',
    footer: '*Generado por [N1nja MCP](https://github.com/luk-s12/n1nja-mcp) - Detector de N+1 en Hibernate*',
    issueTypes: '**Tipos de problemas:**',
    flowSection: '**🔗 Flujo que dispara el problema:**',
    codeLabel: {
      DUPLICATE_QUERY: '⚠️ Metodo con llamadas redundantes al repositorio:',
      MISSING_PAGINATION: '⚠️ Metodo que carga todos los registros sin paginacion:',
      SLOW_QUERY: '⚠️ Codigo que ejecuta esta consulta lenta:',
      LARGE_RESULT_SET: '⚠️ Codigo que carga este resultado sin filtro:',
      OVER_FETCHING: '⚠️ Codigo que carga columnas que nunca usa (over-fetching):',
      POSSIBLE_CARTESIAN_PRODUCT: '⚠️ Codigo que dispara el producto cartesiano:',
      DEADLOCK: '⚠️ Transaccion que participa en el deadlock:',
    },
    codeLabelDefault: '⚠️ Codigo que dispara este problema:',
    triggerLabel: {
      N_PLUS_1: '🔴 N+1 se dispara aqui',
      DUPLICATE_QUERY: '🔴 consulta duplicada aqui',
      MISSING_PAGINATION: '🔴 carga sin paginacion aqui',
      LARGE_RESULT_SET: '🔴 resultado masivo aqui',
      SLOW_QUERY: '🔴 consulta lenta aqui',
      OVER_FETCHING: '🔴 over-fetching aqui',
      POSSIBLE_CARTESIAN_PRODUCT: '🔴 producto cartesiano aqui',
      DEADLOCK: '🔴 deadlock se dispara aqui',
    },
    triggerLabelDefault: '🔴 problema se dispara aqui',
  },

  fixes: {
    joinFetch: {
      description: (_entity, field) =>
        `Agrega JOIN FETCH en la consulta JPQL para cargar ${field} en un solo SQL.`,
    },
    entityGraph: {
      description: (_entity, field) =>
        `Usa @EntityGraph para especificar ${field} como asociacion de carga ansiosa sin modificar el JPQL.`,
    },
    batchFetching: {
      description: (_entity, field) =>
        `Configura el batch fetching de Hibernate para cargar ${field} en lotes en lugar de uno por uno.`,
    },
    dtoProjection: {
      description: (_entity, _field) =>
        `Usa una proyeccion DTO con una sola consulta JOIN para evitar cargar entidades completas.`,
    },
    cache: {
      description: (method) =>
        `Cachea el resultado de ${method} usando Spring Cache.`,
    },
    batchFind: {
      description: 'Si se llama en un loop, reemplaza las llamadas individuales a findById() con findAllById().',
    },
    pagination: {
      description: (entity) =>
        `Agrega el parametro Pageable al metodo del repositorio y retorna Page<${entity}>.`,
    },
    index: {
      description: 'Agrega un indice de base de datos en las columnas usadas en la clausula WHERE / ORDER BY.',
    },
    dtoSlim: {
      description: (_entity) =>
        `Usa una proyeccion de interfaz o clase para SELECT solo las columnas necesarias.`,
    },
  },
};
