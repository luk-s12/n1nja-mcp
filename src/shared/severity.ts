import { Severity } from '../domain/models/issue.model';

/** Traffic-light icon for each issue severity, used across the Markdown reporters. */
const SEVERITY_ICONS: Record<Severity, string> = {
  HIGH: '🔴',
  MEDIUM: '🟡',
  LOW: '🟢',
};

/**
 * Returns the traffic-light emoji for a given severity (defaults to LOW's icon
 * for any unexpected value).
 */
export function severityIcon(severity: Severity): string {
  return SEVERITY_ICONS[severity] ?? SEVERITY_ICONS.LOW;
}
