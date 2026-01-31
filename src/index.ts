import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

const agent = await createAgent({
  name: 'sports-scores-agent',
  version: '1.0.0',
  description: 'Live sports scores aggregator - NFL, NBA, Premier League, and more. Real-time data from ESPN APIs.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === ESPN API Base ===
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// League configs
const LEAGUES = {
  nfl: { path: 'football/nfl', name: 'NFL' },
  nba: { path: 'basketball/nba', name: 'NBA' },
  'premier-league': { path: 'soccer/eng.1', name: 'Premier League' },
  'la-liga': { path: 'soccer/esp.1', name: 'La Liga' },
  mlb: { path: 'baseball/mlb', name: 'MLB' },
  nhl: { path: 'hockey/nhl', name: 'NHL' },
  'college-football': { path: 'football/college-football', name: 'College Football' },
  'college-basketball': { path: 'basketball/mens-college-basketball', name: 'College Basketball' },
} as const;

type LeagueKey = keyof typeof LEAGUES;

async function fetchJSON(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

function parseGame(event: any) {
  const comp = event.competitions?.[0];
  const status = comp?.status;
  const teams = comp?.competitors || [];
  
  const home = teams.find((t: any) => t.homeAway === 'home');
  const away = teams.find((t: any) => t.homeAway === 'away');
  
  return {
    id: event.id,
    name: event.shortName || event.name,
    date: event.date,
    status: {
      state: status?.type?.state || 'unknown',
      detail: status?.type?.detail || status?.type?.description || '',
      clock: status?.displayClock,
      period: status?.period,
    },
    home: home ? {
      name: home.team?.displayName || home.team?.name,
      abbreviation: home.team?.abbreviation,
      score: home.score,
      winner: home.winner,
      logo: home.team?.logo,
    } : null,
    away: away ? {
      name: away.team?.displayName || away.team?.name,
      abbreviation: away.team?.abbreviation,
      score: away.score,
      winner: away.winner,
      logo: away.team?.logo,
    } : null,
    venue: comp?.venue?.fullName,
  };
}

async function getLeagueScores(leagueKey: LeagueKey) {
  const league = LEAGUES[leagueKey];
  const data = await fetchJSON(`${ESPN_BASE}/${league.path}/scoreboard`);
  
  return {
    league: league.name,
    leagueKey,
    fetchedAt: new Date().toISOString(),
    day: data.day?.date,
    events: (data.events || []).map(parseGame),
  };
}

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview of live/recent games across major leagues. Try before you buy.',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    // Check 3 major leagues for live action
    const leagues: LeagueKey[] = ['nfl', 'nba', 'premier-league'];
    const results = await Promise.allSettled(
      leagues.map(async (key) => {
        const data = await getLeagueScores(key);
        const liveGames = data.events.filter((e: any) => e.status.state === 'in');
        return {
          league: data.league,
          totalGames: data.events.length,
          liveGames: liveGames.length,
          sample: data.events.slice(0, 2).map((e: any) => ({
            name: e.name,
            status: e.status.detail,
            score: e.home && e.away ? `${e.away.score || 0} - ${e.home.score || 0}` : 'TBD',
          })),
        };
      })
    );
    
    const summary = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map(r => r.value);
    
    return {
      output: {
        fetchedAt: new Date().toISOString(),
        dataSource: 'ESPN (live)',
        supportedLeagues: Object.keys(LEAGUES),
        summary,
        hint: 'Use paid endpoints for full game data with scores, venues, and team details.',
      },
    };
  },
});

// === PAID ENDPOINT 1 ($0.001): NFL Scores ===
addEntrypoint({
  key: 'nfl',
  description: 'Get current NFL scoreboard with all games, scores, and status',
  input: z.object({}),
  price: { amount: 1000 },
  handler: async () => {
    const data = await getLeagueScores('nfl');
    return { output: data };
  },
});

// === PAID ENDPOINT 2 ($0.001): NBA Scores ===
addEntrypoint({
  key: 'nba',
  description: 'Get current NBA scoreboard with all games, scores, and status',
  input: z.object({}),
  price: { amount: 1000 },
  handler: async () => {
    const data = await getLeagueScores('nba');
    return { output: data };
  },
});

// === PAID ENDPOINT 3 ($0.001): Premier League Scores ===
addEntrypoint({
  key: 'premier-league',
  description: 'Get current Premier League scoreboard with all games, scores, and status',
  input: z.object({}),
  price: { amount: 1000 },
  handler: async () => {
    const data = await getLeagueScores('premier-league');
    return { output: data };
  },
});

// === PAID ENDPOINT 4 ($0.002): Any League Scores ===
addEntrypoint({
  key: 'league',
  description: 'Get scoreboard for any supported league (nfl, nba, premier-league, la-liga, mlb, nhl, college-football, college-basketball)',
  input: z.object({
    league: z.enum(['nfl', 'nba', 'premier-league', 'la-liga', 'mlb', 'nhl', 'college-football', 'college-basketball']),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const data = await getLeagueScores(ctx.input.league);
    return { output: data };
  },
});

// === PAID ENDPOINT 5 ($0.003): Multi-League Dashboard ===
addEntrypoint({
  key: 'dashboard',
  description: 'Live dashboard across multiple leagues in one call. Get all live and recent games.',
  input: z.object({
    leagues: z.array(z.enum(['nfl', 'nba', 'premier-league', 'la-liga', 'mlb', 'nhl', 'college-football', 'college-basketball']))
      .min(1)
      .max(4)
      .optional()
      .default(['nfl', 'nba', 'premier-league']),
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const results = await Promise.allSettled(
      ctx.input.leagues.map(key => getLeagueScores(key))
    );
    
    const dashboard = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map(r => r.value);
    
    const totalGames = dashboard.reduce((sum, d) => sum + d.events.length, 0);
    const liveGames = dashboard.reduce(
      (sum, d) => sum + d.events.filter((e: any) => e.status.state === 'in').length,
      0
    );
    
    return {
      output: {
        fetchedAt: new Date().toISOString(),
        totalGames,
        liveGames,
        leagues: dashboard,
      },
    };
  },
});

// === Serve icon ===
app.get('/icon.png', async (c) => {
  try {
    const fs = await import('fs');
    const icon = fs.readFileSync('./icon.png');
    return new Response(icon, {
      headers: { 'Content-Type': 'image/png' },
    });
  } catch {
    return c.text('Icon not found', 404);
  }
});

// === ERC-8004 Registration ===
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return c.json({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'sports-scores-agent',
    description: 'Live sports scores aggregator. NFL, NBA, Premier League and more. Real-time data via x402 micropayments. 1 free + 5 paid endpoints.',
    image: `${baseUrl}/icon.png`,
    services: [
      { name: 'web', endpoint: baseUrl },
      { name: 'A2A', endpoint: `${baseUrl}/.well-known/agent.json`, version: '0.3.0' },
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ['reputation'],
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🏈🏀⚽ Sports Scores Agent running on port ${port}`);
console.log(`Supported leagues: ${Object.keys(LEAGUES).join(', ')}`);

export default { port, fetch: app.fetch };
