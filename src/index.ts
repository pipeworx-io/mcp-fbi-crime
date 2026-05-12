interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * FBI Crime Data Explorer MCP — UCR/NIBRS statistics
 *
 * Distinct from `fbiwanted` (active fugitives). This is aggregated crime
 * statistics (arrests, offenses, victims, locations) at national, state,
 * and reporting-agency (ORI) levels.
 *
 * API: https://api.usa.gov/crime/fbi/cde/
 * Auth: ?api_key= using your data.gov key (free at https://api.data.gov/signup).
 *
 * Note: the upstream FBI CDE has been intermittently flaky on DEMO_KEY. Real
 * registered keys typically work; if you see 5xx, retry.
 *
 * Tools:
 * - list_agencies:        agencies by state (ORIs to use with other tools)
 * - get_agency:           single agency by ORI
 * - national_estimate:    nationwide rate / count estimates for an offense
 * - state_summary:        summarized counts at the state level over date range
 * - agency_summary:       summarized counts at the agency level over date range
 */


const BASE_URL = 'https://api.usa.gov/crime/fbi/cde';

const OFFENSES = [
  'aggravated-assault', 'all-other-offenses', 'arson', 'burglary',
  'destruction-of-property', 'drug-offenses', 'fraud', 'human-trafficking',
  'kidnapping', 'larceny', 'motor-vehicle-theft', 'murder',
  'robbery', 'rape-legacy', 'rape-revised', 'sex-offenses', 'simple-assault',
  'stolen-property', 'vandalism', 'violent-crime', 'property-crime',
];

const tools: McpToolExport['tools'] = [
  {
    name: 'list_agencies',
    description:
      'List reporting agencies (police departments / sheriffs) for a state. Returns ORI (Originating Reporting Identifier) — the canonical agency ID required by the other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        state_abbr: { type: 'string', description: '2-letter state code (e.g., "CA"). Omit to list all.' },
      },
      required: [],
    },
  },
  {
    name: 'get_agency',
    description: 'Fetch a single agency record by ORI.',
    inputSchema: {
      type: 'object',
      properties: {
        ori: { type: 'string', description: '9-character ORI (e.g., "CA0194200" = LAPD)' },
      },
      required: ['ori'],
    },
  },
  {
    name: 'national_estimate',
    description:
      'National crime rate + count estimates for an offense across a year range. Useful for "how has X crime trended nationally".',
    inputSchema: {
      type: 'object',
      properties: {
        offense: { type: 'string', description: 'Offense slug (e.g., "violent-crime", "murder", "burglary")' },
        from: { type: 'number', description: 'Start year (default 2020)' },
        to: { type: 'number', description: 'End year (default current)' },
      },
      required: ['offense'],
    },
  },
  {
    name: 'state_summary',
    description:
      'Summarized monthly counts of an offense in a state. Returns time-series and totals.',
    inputSchema: {
      type: 'object',
      properties: {
        state_abbr: { type: 'string', description: '2-letter state code' },
        offense: { type: 'string', description: 'Offense slug' },
        from: { type: 'string', description: 'YYYY-MM (default 5 years ago)' },
        to: { type: 'string', description: 'YYYY-MM (default current)' },
      },
      required: ['state_abbr', 'offense'],
    },
  },
  {
    name: 'agency_summary',
    description:
      'Summarized monthly counts of an offense for one agency (by ORI). Returns time-series of victims/incidents/offenders.',
    inputSchema: {
      type: 'object',
      properties: {
        ori: { type: 'string', description: '9-character ORI' },
        offense: { type: 'string', description: 'Offense slug' },
        from: { type: 'string', description: 'YYYY-MM' },
        to: { type: 'string', description: 'YYYY-MM' },
      },
      required: ['ori', 'offense'],
    },
  },
  {
    name: 'list_offense_slugs',
    description:
      'List the offense slugs accepted by national_estimate / state_summary / agency_summary. Returns a static list.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = (args._apiKey as string | undefined)?.trim();
  if (!apiKey && name !== 'list_offense_slugs') {
    throw new Error(
      'FBI Crime Data requires a data.gov API key. Contact the operator about platform credentials (PLATFORM_DATAGOV_KEY), or BYO via ?_apiKey=<key> after registering at https://api.data.gov/signup.',
    );
  }
  switch (name) {
    case 'list_offense_slugs':
      return { offenses: OFFENSES, count: OFFENSES.length };
    case 'list_agencies':
      return listAgencies(apiKey as string, args.state_abbr as string | undefined);
    case 'get_agency':
      return getAgency(apiKey as string, reqStr(args, 'ori', '"CA0194200" (LAPD)'));
    case 'national_estimate':
      return nationalEstimate(
        apiKey as string,
        reqStr(args, 'offense', '"violent-crime"'),
        args.from as number | undefined,
        args.to as number | undefined,
      );
    case 'state_summary':
      return stateSummary(apiKey as string, args);
    case 'agency_summary':
      return agencySummary(apiKey as string, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing or empty. Pass a string like ${example}.`);
  }
  return v;
}

async function fbiGet<T>(apiKey: string, path: string, params: URLSearchParams): Promise<T> {
  params.set('api_key', apiKey);
  const url = `${BASE_URL}${path}?${params}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) throw new Error('FBI CDE: unauthorized — check the data.gov key');
  if (res.status === 429) throw new Error('FBI CDE: rate-limit (HTTP 429)');
  if (res.status >= 500) {
    throw new Error(
      `FBI CDE: upstream ${res.status} — the underlying CDE proxy is intermittently flaky, especially on DEMO_KEY. Retry shortly with a registered data.gov key.`,
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FBI CDE error: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function listAgencies(apiKey: string, stateAbbr?: string) {
  const params = new URLSearchParams();
  const path = stateAbbr ? `/agencies/${encodeURIComponent(stateAbbr.toUpperCase())}` : '/agencies';
  const data = await fbiGet<unknown>(apiKey, path, params);
  return { state: stateAbbr ?? null, data };
}

async function getAgency(apiKey: string, ori: string) {
  const data = await fbiGet<unknown>(apiKey, `/agency/byori/${encodeURIComponent(ori)}`, new URLSearchParams());
  return { ori, data };
}

async function nationalEstimate(apiKey: string, offense: string, from?: number, to?: number) {
  const now = new Date().getUTCFullYear();
  const f = from ?? now - 5;
  const t = to ?? now;
  const data = await fbiGet<unknown>(
    apiKey,
    `/estimate/national/${encodeURIComponent(offense)}/${f}/${t}`,
    new URLSearchParams(),
  );
  return { offense, from: f, to: t, data };
}

async function stateSummary(apiKey: string, args: Record<string, unknown>) {
  const state = reqStr(args, 'state_abbr', '"CA"').toUpperCase();
  const offense = reqStr(args, 'offense', '"violent-crime"');
  const from = (args.from as string) ?? '2020-01';
  const to = (args.to as string) ?? new Date().toISOString().slice(0, 7);
  const data = await fbiGet<unknown>(
    apiKey,
    `/summarized/state/${encodeURIComponent(state)}/${encodeURIComponent(offense)}/${from}/${to}`,
    new URLSearchParams(),
  );
  return { state, offense, from, to, data };
}

async function agencySummary(apiKey: string, args: Record<string, unknown>) {
  const ori = reqStr(args, 'ori', '"CA0194200"');
  const offense = reqStr(args, 'offense', '"violent-crime"');
  const from = (args.from as string) ?? '2020-01';
  const to = (args.to as string) ?? new Date().toISOString().slice(0, 7);
  const data = await fbiGet<unknown>(
    apiKey,
    `/summarized/agency/${encodeURIComponent(ori)}/${encodeURIComponent(offense)}/${from}/${to}`,
    new URLSearchParams(),
  );
  return { ori, offense, from, to, data };
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;
