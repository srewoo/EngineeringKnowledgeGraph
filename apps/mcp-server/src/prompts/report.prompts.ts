/**
 * MCP Prompts: dependency-report, impact-assessment
 *
 * Pre-built prompt templates that AI agents can use
 * to generate structured reports from graph data.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer): void {
  server.prompt(
    'dependency-report',
    'Generate a structured dependency report for a service. Use with get_dependencies and get_service_summary tools.',
    { service: z.string().describe('Service name to generate report for') },
    ({ service }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Generate a comprehensive dependency report for the service "${service}".

Follow these steps:
1. Call get_service_summary for "${service}" to get an overview
2. Call get_dependencies for "${service}" with depth 3 to find transitive dependencies
3. Call list_databases to identify all databases

Then produce a structured report with:

## Service: ${service}

### Direct Dependencies
- List each service, database, and API this service directly depends on

### Transitive Dependencies
- List dependencies discovered at depth 2 and 3

### Databases Used
- List each database with its type and detection method

### Risk Assessment
- Flag any single points of failure
- Identify circular dependencies
- Note any high fan-out services (many dependencies)

### Recommendations
- Suggest decoupling opportunities
- Flag unused or redundant dependencies`,
        },
      }],
    }),
  );

  server.prompt(
    'impact-assessment',
    'Generate an impact assessment for a planned change to a service or database. Use with analyze_impact tool.',
    {
      node: z.string().describe('Name of the service/database being changed'),
      changeType: z.string().optional().describe('Type of change: api_change, db_change, removal, modification'),
    },
    ({ node, changeType }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Perform an impact assessment for a planned ${changeType ?? 'modification'} to "${node}".

Follow these steps:
1. Call analyze_impact for "${node}" with depth 4
2. Call get_service_summary for "${node}" to understand what it provides
3. For each directly affected service, call get_service_summary to understand the blast radius

Then produce a structured assessment:

## Impact Assessment: ${changeType ?? 'Change'} to ${node}

### Change Summary
- What is being changed and why (based on the change type: ${changeType ?? 'modification'})

### Directly Affected (Depth 1)
- Services that directly depend on ${node}
- APIs that will be impacted
- Estimated severity: HIGH / MEDIUM / LOW for each

### Indirectly Affected (Depth 2+)
- Transitive dependents grouped by depth
- Cascading risk assessment

### Database Impact
- Any data migration requirements
- Connection string changes needed

### Action Items
- [ ] Services that need code changes
- [ ] Tests that need to be updated
- [ ] APIs that need version bumps
- [ ] Documentation that needs updating

### Risk Level
- Overall risk: HIGH / MEDIUM / LOW
- Confidence in assessment: HIGH / MEDIUM / LOW
- Recommendation: PROCEED / PROCEED WITH CAUTION / BLOCK`,
        },
      }],
    }),
  );
}
