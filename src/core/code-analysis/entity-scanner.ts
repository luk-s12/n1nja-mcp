import * as path from 'path';
import { getJavaSources } from './source-cache';

export interface EntityAssociation {
  fieldName: string;
  targetEntity: string;
  annotationType: 'OneToMany' | 'ManyToMany' | 'ManyToOne' | 'OneToOne';
  fetchType?: 'LAZY' | 'EAGER';
  mappedBy?: string;
  isBag: boolean; // List without @OrderColumn is a Hibernate "bag"
  /** 1-based line of the association annotation in the entity file. */
  lineNumber: number;
}

export interface ScannedEntity {
  className: string;
  tableName?: string;
  filePath: string;
  associations: EntityAssociation[];
  hasBatchSize: boolean;
  batchSizeValue?: number;
}

const ENTITY_ANNOTATION = /@Entity\b/;
const TABLE_ANNOTATION = /@Table\s*\(\s*name\s*=\s*["']([^"']+)["']/;
const ASSOCIATION_ANNOTATION = /@(OneToMany|ManyToMany|ManyToOne|OneToOne)\s*(?:\([^)]*\))?/;
const FETCH_TYPE = /fetch\s*=\s*FetchType\.(\w+)/;
const MAPPED_BY = /mappedBy\s*=\s*["']([^"']+)["']/;
const FIELD_DECLARATION = /(?:private|protected)\s+(?:List|Set|Collection|Map|Optional|[\w<>, ]+)\s+(\w+)\s*[;=]/;
const BATCH_SIZE = /@BatchSize\s*\(\s*size\s*=\s*(\d+)/;

/**
 * Scans a directory tree for JPA @Entity classes and extracts their associations.
 */
export function scanEntities(projectRoot: string): ScannedEntity[] {
  const entities: ScannedEntity[] = [];

  for (const src of getJavaSources(projectRoot)) {
    if (!ENTITY_ANNOTATION.test(src.content)) continue;

    const entity = parseEntityFile(src.filePath, src.content);
    if (entity) entities.push(entity);
  }

  return entities;
}

function parseEntityFile(filePath: string, content: string): ScannedEntity | null {
  const lines = content.split('\n');
  const className = path.basename(filePath, '.java');

  const tableMatch = content.match(TABLE_ANNOTATION);
  const tableName = tableMatch ? tableMatch[1] : toSnakeCase(className);

  const associations: EntityAssociation[] = [];
  let hasBatchSize = false;
  let batchSizeValue: number | undefined;

  const batchMatch = content.match(BATCH_SIZE);
  if (batchMatch) {
    hasBatchSize = true;
    batchSizeValue = parseInt(batchMatch[1], 10);
  }

  // Parse associations line by line with lookahead context
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const assocMatch = line.match(ASSOCIATION_ANNOTATION);
    if (!assocMatch) continue;

    const annotationType = assocMatch[1] as EntityAssociation['annotationType'];

    // Gather the full annotation block (may span multiple lines)
    let annotationBlock = line;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim().startsWith('@') && !lines[j].includes('{')) {
      annotationBlock += ' ' + lines[j];
      j++;
      if (j - i > 5) break; // safety
    }

    const fetchMatch = annotationBlock.match(FETCH_TYPE);
    const fetchType = fetchMatch ? (fetchMatch[1] as 'LAZY' | 'EAGER') : undefined;

    const mappedByMatch = annotationBlock.match(MAPPED_BY);
    const mappedBy = mappedByMatch ? mappedByMatch[1] : undefined;

    // Find the field declaration after the annotation
    let fieldName = 'unknown';
    for (let k = i + 1; k < Math.min(i + 8, lines.length); k++) {
      const fieldMatch = lines[k].match(FIELD_DECLARATION);
      if (fieldMatch) {
        fieldName = fieldMatch[1];
        break;
      }
    }

    // Is it a bag? (List/Collection without @OrderColumn, for OneToMany/ManyToMany)
    const isBag =
      (annotationType === 'OneToMany' || annotationType === 'ManyToMany') &&
      /\b(List|Collection)\b/.test(annotationBlock + (lines[i + 1] ?? '')) &&
      !lines.slice(Math.max(0, i - 3), i + 1).some((l) => /@OrderColumn/.test(l));

    // Extract target entity from the field declaration.
    // For collection associations (OneToMany/ManyToMany): extract generic type param → List<Order>
    // For single associations (ManyToOne/OneToOne): extract the field type directly → private Order order
    const fieldBlock = lines.slice(i + 1, i + 6).join(' ');
    const genericMatch = fieldBlock.match(/List<(\w+)>|Set<(\w+)>|Collection<(\w+)>/);
    const simpleTypeMatch = fieldBlock.match(/(?:private|protected)\s+(\w+)\s+\w+\s*[;=]/);
    const targetEntity = genericMatch
      ? (genericMatch[1] ?? genericMatch[2] ?? genericMatch[3] ?? 'Unknown')
      : (simpleTypeMatch ? simpleTypeMatch[1] : 'Unknown');

    associations.push({ fieldName, targetEntity, annotationType, fetchType, mappedBy, isBag, lineNumber: i + 1 });
  }

  return { className, tableName, filePath, associations, hasBatchSize, batchSizeValue };
}

function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}
