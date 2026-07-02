import { IssueType } from '../../domain/models/issue.model';
import { capitalize } from './java-utils';

export type FixStrategy = 'JOIN_FETCH' | 'ENTITY_GRAPH' | 'DTO_PROJECTION' | 'BATCH_FETCHING' | 'PAGINATION' | 'CURSOR_PAGINATION' | 'INDEX' | 'CACHE';

export interface FixSuggestion {
  strategy: FixStrategy;
  priority: number; // 1 = best fit
  description: string;
  codeExample: string;
}

/** Human-readable label for a fix strategy (kept next to the type it describes). */
const STRATEGY_LABELS: Record<FixStrategy, string> = {
  JOIN_FETCH: 'JOIN FETCH',
  ENTITY_GRAPH: '@EntityGraph',
  DTO_PROJECTION: 'DTO Projection',
  BATCH_FETCHING: '@BatchSize / findAllById()',
  PAGINATION: 'Offset Pagination (Pageable)',
  CURSOR_PAGINATION: 'Cursor Pagination (Keyset)',
  INDEX: 'Add Database Index',
  CACHE: '@Cacheable',
};

export function strategyLabel(strategy: FixStrategy): string {
  return STRATEGY_LABELS[strategy] ?? strategy;
}

/**
 * Returns an ordered list of fix suggestions for a given issue type and context.
 */
export function suggestFixes(
  issueType: IssueType,
  context: {
    entityName?: string;
    fieldName?: string;
    collectionType?: 'OneToMany' | 'ManyToMany' | 'ManyToOne' | 'OneToOne' | 'unknown';
    isInLoop?: boolean;
    repositoryMethod?: string;
    hasMultipleBagCollections?: boolean;
    /** Name of the cursor field to use for keyset pagination (defaults to "id") */
    cursorField?: string;
    /** Columns the triggering method actually reads (for OVER_FETCHING projection) */
    usedColumns?: string[];
  },
): FixSuggestion[] {
  const {
    entityName = 'Entity',
    fieldName = 'association',
    collectionType = 'unknown',
    repositoryMethod,
    hasMultipleBagCollections,
    cursorField = 'id',
    usedColumns,
  } = context;

  const builders: Partial<Record<IssueType, () => FixSuggestion[]>> = {
    N_PLUS_1: () => {
    const suggestions: FixSuggestion[] = [];

    // If multiple bag collections: can't use JOIN FETCH safely
    if (!hasMultipleBagCollections) {
      suggestions.push({
        strategy: 'JOIN_FETCH',
        priority: 1,
        description: `Add JOIN FETCH in the JPQL query to load ${fieldName} in a single SQL statement.`,
        codeExample: `// In ${entityName}Repository:
@Query("SELECT e FROM ${entityName} e JOIN FETCH e.${fieldName} WHERE ...")
List<${entityName}> findAllWith${capitalize(fieldName)}();`,
      });
    }

    suggestions.push({
      strategy: 'ENTITY_GRAPH',
      priority: hasMultipleBagCollections ? 1 : 2,
      description: `Use @EntityGraph to specify ${fieldName} as an eagerly-fetched association without modifying JPQL.`,
      codeExample: `// On the entity:
@NamedEntityGraph(
  name = "${entityName}.with${capitalize(fieldName)}",
  attributeNodes = @NamedAttributeNode("${fieldName}")
)
@Entity
public class ${entityName} { ... }

// On the repository method:
@EntityGraph(value = "${entityName}.with${capitalize(fieldName)}", type = EntityGraph.EntityGraphType.FETCH)
List<${entityName}> findAll();`,
    });

    suggestions.push({
      strategy: 'BATCH_FETCHING',
      priority: 3,
      description: `Configure Hibernate batch fetching to load ${fieldName} in batches instead of one-by-one.`,
      codeExample: `// On the collection field in ${entityName}:
@BatchSize(size = 25)
@OneToMany(mappedBy = "...")
private List<${fieldName}Type> ${fieldName};

// Or globally in application.properties:
spring.jpa.properties.hibernate.default_batch_fetch_size=25`,
    });

    if (collectionType === 'OneToMany' || collectionType === 'ManyToMany') {
      suggestions.push({
        strategy: 'DTO_PROJECTION',
        priority: 4,
        description: `Use a DTO projection with a single JOIN query to avoid loading full entities.`,
        codeExample: `// DTO:
public record ${entityName}${capitalize(fieldName)}Dto(Long id, String name, ...) {}

// Repository:
@Query("SELECT new com.example.${entityName}${capitalize(fieldName)}Dto(e.id, e.name, ...) FROM ${entityName} e JOIN e.${fieldName} f")
List<${entityName}${capitalize(fieldName)}Dto> findAllAsDto();`,
      });
    }

    return suggestions;
    },

    DUPLICATE_QUERY: () => [
      {
        strategy: 'CACHE',
        priority: 1,
        description: `Cache the result of ${repositoryMethod ?? 'this repository method'} using Spring Cache.`,
        codeExample: `@Cacheable("${entityName?.toLowerCase() ?? 'entities'}")
${repositoryMethod ? `${repositoryMethod}` : `public ${entityName} findById(Long id)`} { ... }

// application.properties:
spring.cache.type=caffeine
spring.cache.caffeine.spec=maximumSize=500,expireAfterWrite=10m`,
      },
      {
        strategy: 'BATCH_FETCHING',
        priority: 2,
        description: `If called in a loop, replace individual findById() calls with findAllById().`,
        codeExample: `// Instead of:
for (Long id : ids) {
    Entity e = repository.findById(id).orElseThrow();
    process(e);
}

// Use:
List<Entity> entities = repository.findAllById(ids);
entities.forEach(this::process);`,
      },
    ],

    MISSING_PAGINATION: () => {
    const entity = entityName;
    const entityLower = entity.toLowerCase();
    const cursor = cursorField;

    return [
      {
        strategy: 'PAGINATION',
        priority: 1,
        description:
          `Add a Pageable parameter to the repository method and return Page<T>. ` +
          `Simple to implement and integrates with Spring Data slicing out of the box. ` +
          `Suitable for moderate datasets; for very large tables prefer cursor-based pagination (Fix 2).`,
        codeExample: `// Repository — add Pageable overload:
Page<${entity}> findAll(Pageable pageable);

// Service:
public Page<${entity}> get${entity}Page(int page, int size) {
    Pageable pageable = PageRequest.of(page, size, Sort.by("${cursor}").ascending());
    return ${entityLower}Repository.findAll(pageable);
}

// Controller:
@GetMapping("/${entityLower}s")
public ResponseEntity<Page<${entity}>> list(
        @RequestParam(defaultValue = "0") int page,
        @RequestParam(defaultValue = "20") int size) {
    return ResponseEntity.ok(service.get${entity}Page(page, size));
}`,
      },
      {
        strategy: 'CURSOR_PAGINATION',
        priority: 2,
        description:
          `Use cursor-based (keyset) pagination for large tables. ` +
          `Instead of OFFSET (which scans all skipped rows), the query uses ` +
          `WHERE ${cursor} > :cursor ORDER BY ${cursor} LIMIT N — O(1) regardless of page depth. ` +
          `Ideal when the table has millions of rows or when real-time feeds require stable ordering.`,
        codeExample: `// Repository — keyset query on "${cursor}":
@Query("SELECT e FROM ${entity} e WHERE e.${cursor} > :cursor ORDER BY e.${cursor} ASC")
Slice<${entity}> findNextPage(@Param("cursor") Long cursor, Pageable pageable);

// For composite cursor (e.g. created_at + id to break ties):
@Query("""
    SELECT e FROM ${entity} e
    WHERE (e.createdAt, e.id) > (:lastCreatedAt, :lastId)
    ORDER BY e.createdAt ASC, e.id ASC
    """)
Slice<${entity}> findNextPageComposite(
    @Param("lastCreatedAt") java.time.LocalDateTime lastCreatedAt,
    @Param("lastId") Long lastId,
    Pageable pageable);

// Service — stateless cursor; the client tracks lastCursor:
public CursorPage<${entity}> get${entity}Page(Long cursor, int size) {
    Slice<${entity}> slice = ${entityLower}Repository
        .findNextPage(cursor, PageRequest.of(0, size)); // page=0, only LIMIT matters
    Long nextCursor = slice.hasNext()
        ? slice.getContent().get(slice.getNumberOfElements() - 1).get${capitalize(cursor)}()
        : null;
    return new CursorPage<>(slice.getContent(), nextCursor, slice.hasNext());
}

// CursorPage record (put in dto/ package):
public record CursorPage<T>(List<T> data, Long nextCursor, boolean hasMore) {}

// Controller:
@GetMapping("/${entityLower}s")
public ResponseEntity<CursorPage<${entity}>> list(
        @RequestParam(defaultValue = "0") Long cursor,
        @RequestParam(defaultValue = "20") int size) {
    return ResponseEntity.ok(service.get${entity}Page(cursor, size));
}

// Why cursor beats OFFSET on large tables:
//   OFFSET 10000 LIMIT 20  → DB scans 10 020 rows, discards 10 000
//   WHERE id > 10000 LIMIT 20 → DB reads exactly 20 rows via index seek`,
      },
    ];
    },

    POSSIBLE_CARTESIAN_PRODUCT: () => [
      {
        strategy: 'BATCH_FETCHING',
        priority: 1,
        description:
          `Replace simultaneous JOIN FETCH on sibling collections with @BatchSize. ` +
          `Hibernate issues one IN-query per collection instead of a Cartesian explosion. ` +
          `This is the recommended fix when the entity has two or more @OneToMany / @ElementCollection.`,
        codeExample: `// On each collection field in ${entityName}:
@BatchSize(size = 25)
@OneToMany(mappedBy = "...")
private List<Order> orders;

@BatchSize(size = 25)
@ElementCollection
private Set<String> tags;

// Or set globally in application.properties (applies to all collections):
spring.jpa.properties.hibernate.default_batch_fetch_size=25

// Then remove the multi-JOIN FETCH query and use a plain findById:
// BEFORE (Cartesian explosion):
// @Query("SELECT c FROM Customer c JOIN FETCH c.orders JOIN FETCH c.tags WHERE c.id = :id")
// AFTER: customerRepository.findById(id)  ← 1 query + 2 batch IN-queries`,
      },
      {
        strategy: 'ENTITY_GRAPH',
        priority: 2,
        description:
          `Load one collection with @EntityGraph and let the other be fetched by a separate query ` +
          `(combined with @BatchSize or a targeted @Query). ` +
          `Never put two bag/collection paths in the same @EntityGraph — that also causes Cartesian product.`,
        codeExample: `// Load only orders eagerly — tags remain lazy (loaded later with @BatchSize):
@EntityGraph(attributePaths = {"orders"})
Optional<${entityName ?? 'Entity'}> findByIdWithOrders(Long id);

// Or use two targeted queries and merge in the service:
${entityName ?? 'Entity'} entity = repo.findByIdWithOrders(id).orElseThrow();
// tags are batch-fetched automatically when accessed`,
      },
      {
        strategy: 'DTO_PROJECTION',
        priority: 3,
        description:
          `Use two separate DTO queries — one per collection — and merge in the service layer. ` +
          `This is the most explicit fix: each query is simple, predictable, and index-friendly.`,
        codeExample: `// Query 1: load root entity + one collection
${entityName ?? 'Entity'} entity = repo.findByIdWithOrders(id).orElseThrow();

// Query 2: load second collection with a targeted query
List<String> tags = tagRepo.findTagsByCustomerId(id);

// Merge in memory — total: 2 simple queries, 0 Cartesian rows`,
      },
    ],

    OVER_FETCHING: () => {
    const entity = entityName;
    const cols = usedColumns && usedColumns.length > 0 ? usedColumns : ['id', 'name'];
    const fields = cols.map(toCamelField);
    const recordParams = fields.map((f) => `${fieldType(f)} ${f}`).join(', ');
    const jpqlCols = fields.map((f) => `e.${f}`).join(', ');
    const getters = fields.map((f) => `    ${fieldType(f)} get${capitalize(f)}();`).join('\n');

    return [
      {
        strategy: 'DTO_PROJECTION',
        priority: 1,
        description:
          `Select only the columns the code uses with a constructor (class) projection. ` +
          `Hibernate then emits SELECT ${jpqlCols} instead of the full row.`,
        codeExample: `// DTO:
public record ${entity}Dto(${recordParams}) {}

// Repository:
@Query("SELECT new com.example.dto.${entity}Dto(${jpqlCols}) FROM ${entity} e")
List<${entity}Dto> findAllProjected();`,
      },
      {
        strategy: 'DTO_PROJECTION',
        priority: 2,
        description:
          `Or use a Spring Data interface projection — no @Query needed; Spring Data ` +
          `generates a SELECT with only these columns automatically.`,
        codeExample: `// Projection interface:
public interface ${entity}View {
${getters}
}

// Repository:
List<${entity}View> findAllBy();`,
      },
    ];
    },

    SLOW_QUERY: () => [
      {
        strategy: 'INDEX',
        priority: 1,
        description: 'Add a database index on the columns used in the WHERE / ORDER BY clause.',
        codeExample: `// On entity:
@Table(indexes = {
    @Index(name = "idx_${entityName?.toLowerCase() ?? 'entity'}_column", columnList = "column_name")
})
@Entity
public class ${entityName} { ... }

// Or as a Flyway migration:
CREATE INDEX idx_${entityName?.toLowerCase() ?? 'entity'}_column ON ${entityName?.toLowerCase() ?? 'entity'} (column_name);`,
      },
      {
        strategy: 'DTO_PROJECTION',
        priority: 2,
        description: 'Use an interface or class projection to SELECT only needed columns.',
        codeExample: `// Projection interface:
public interface ${entityName}Summary {
    Long getId();
    String getName();
}

// Repository:
List<${entityName}Summary> findAllProjectedBy();`,
      },
    ],
  };

  return builders[issueType]?.() ?? [];
}

/** snake_case or plain column → camelCase Java field name */
function toCamelField(column: string): string {
  const parts = column.toLowerCase().split('_').filter(Boolean);
  if (parts.length === 0) return column;
  return parts[0] + parts.slice(1).map(capitalize).join('');
}

/** Best-effort Java type for a column name (id-like → Long, else String) */
function fieldType(field: string): string {
  return field === 'id' || /Id$/.test(field) ? 'Long' : 'String';
}
