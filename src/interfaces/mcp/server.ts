import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { tools } from './registry';
import { loadLanguageConfig, getLanguage } from '../../shared/i18n';

// Single source of truth for the server version (runtime require avoids tsc
// rootDir issues with importing package.json from outside src/).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../../../package.json') as { version: string };

/**
 * Builds the MCP server and wires the tool registry to the protocol:
 *  - tools/list advertises each tool with a JSON Schema derived from its Zod schema.
 *  - tools/call validates input with Zod, runs the use case, and formats the result.
 *
 * No business logic lives here — see ./registry.ts.
 */
export function createMcpServer(): Server {
  const server = new Server(
    { name: 'n1nja', version },
    { capabilities: { tools: {} } },
  );

  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema) as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const tool = toolByName.get(name);

    if (!tool) {
      return {
        content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      return {
        content: [{ type: 'text', text: `Invalid arguments for ${name}:\n${issues}` }],
        isError: true,
      };
    }

    try {
      return (await tool.run(parsed.data)) as CallToolResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Bootstraps the server over stdio. Loads the language config first so all
 * reports render in the configured locale.
 */
export async function startMcpServer(): Promise<void> {
  loadLanguageConfig();
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`🥷 N1nja MCP started [lang: ${getLanguage()}]\n`);
}
