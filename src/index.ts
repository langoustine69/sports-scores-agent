import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';

const agent = await createAgent({
  name: 'sports-scores-agent',
  version: '1.0.0',
  description: 'Real-time sports scores and schedules from ESPN. Multi-sport coverage: UFC/MMA, Boxing, NBA, NFL, NHL.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === ESPN API Configuration ===
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const SPORTS_CONFIG: Record<string, { path: string; name: string }> = {
  ufc: { path: 'mma/ufc', name: 'UFC/MMA' },
  mma: { path: 'mma/ufc', name: 'UFC/MMA' },
  boxing: { path: 'boxing', name: 'Boxing' },
  nba: { path: 'basketball/nba', name: 'NBA' },
  nfl: { path: 'football/nfl', name: 'NFL' },
  nhl: { path: 'hockey/nhl', name: 'NHL' },
  mlb: { path: 'baseball/mlb', name: 'MLB' },
  ncaaf: { path: 'football/college-football', name: 'College Football' },
  ncaab: { path: 'basketball/mens-college-basketball', name: 'College Basketball' },
};

// === Helper Functions ===
async function fetchESPN(sportPath: string): Promise<any> {
  const url = `${ESPN_BASE}/${sportPath}/scoreboard`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ESPN API error: ${response.status}`);
  return response.json();
}

function normalizeEvent(event: any, sport: string): any {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];
  
  return {
    id: event.id,
    name: event.name,
    shortName: event.shortName,
    sport: sport,
    date: event.date,
    status: {
      type: event.status?.type?.name,
      detail: event.status?.type?.shortDetail || event.status?.type?.description,
      completed: event.status?.type?.completed,
    },
    venue: competition?.venue?.fullName,
    competitors: competitors.map((c: any) => ({
      name: c.team?.displayName || c.athlete?.displayName,
      abbreviation: c.team?.abbreviation,
      score: c.score,
      winner: c.winner,
      homeAway: c.homeAway,
    })),
  };
}

async function getAllSportsScores(): Promise<any[]> {
  const results = await Promise.allSettled(
    Object.entries(SPORTS_CONFIG).map(async ([key, config]) => {
      const data = await fetchESPN(config.path);
      return (data.events || []).map((e: any) => normalizeEvent(e, config.name));
    })
  );
  
  return results
    .filter((r): r is PromiseFulfilledResult<any[]> => r.status === 'fulfilled')
    .flatMap(r => r.value);
}

// === FREE ENDPOINT ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview of todays sports events across all major leagues',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const allEvents = await getAllSportsScores();
    const live = allEvents.filter(e => e.status.type === 'STATUS_IN_PROGRESS');
    const final = allEvents.filter(e => e.status.completed);
    const upcoming = allEvents.filter(e => e.status.type === 'STATUS_SCHEDULED');
    
    return {
      output: {
        summary: {
          totalEvents: allEvents.length,
          liveNow: live.length,
          completed: final.length,
          upcoming: upcoming.length,
        },
        sportsAvailable: Object.values(SPORTS_CONFIG).map(c => c.name),
        sampleEvents: allEvents.slice(0, 3),
        fetchedAt: new Date().toISOString(),
        dataSource: 'ESPN API (live)',
      },
    };
  },
});

// === PAID ENDPOINT 1: Live Games ($0.001) ===
addEntrypoint({
  key: 'live',
  description: 'All live games happening right now across all sports',
  input: z.object({}),
  price: { amount: 1000 },
  handler: async () => {
    const allEvents = await getAllSportsScores();
    const liveEvents = allEvents.filter(e => 
      e.status.type === 'STATUS_IN_PROGRESS' || 
      e.status.detail?.toLowerCase().includes('in progress')
    );
    
    return {
      output: {
        liveCount: liveEvents.length,
        events: liveEvents,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 2: Sport-Specific ($0.002) ===
addEntrypoint({
  key: 'sport',
  description: 'Get scores for a specific sport (ufc, boxing, nba, nfl, nhl, mlb)',
  input: z.object({
    sport: z.enum(['ufc', 'mma', 'boxing', 'nba', 'nfl', 'nhl', 'mlb', 'ncaaf', 'ncaab']),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const config = SPORTS_CONFIG[ctx.input.sport];
    if (!config) {
      return { output: { error: 'Unknown sport', availableSports: Object.keys(SPORTS_CONFIG) } };
    }
    
    const data = await fetchESPN(config.path);
    const events = (data.events || []).map((e: any) => normalizeEvent(e, config.name));
    
    return {
      output: {
        sport: config.name,
        eventCount: events.length,
        events,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 3: Search Teams/Fighters ($0.002) ===
addEntrypoint({
  key: 'search',
  description: 'Search events by team or fighter name',
  input: z.object({
    query: z.string().min(2).describe('Team or fighter name to search'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const allEvents = await getAllSportsScores();
    const query = ctx.input.query.toLowerCase();
    
    const matches = allEvents.filter(e => 
      e.name.toLowerCase().includes(query) ||
      e.shortName?.toLowerCase().includes(query) ||
      e.competitors?.some((c: any) => 
        c.name?.toLowerCase().includes(query) ||
        c.abbreviation?.toLowerCase().includes(query)
      )
    );
    
    return {
      output: {
        query: ctx.input.query,
        matchCount: matches.length,
        events: matches,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 4: Upcoming Events ($0.003) ===
addEntrypoint({
  key: 'upcoming',
  description: 'Upcoming scheduled events across all sports',
  input: z.object({
    sport: z.enum(['all', 'ufc', 'mma', 'boxing', 'nba', 'nfl', 'nhl', 'mlb']).optional().default('all'),
    limit: z.number().min(1).max(50).optional().default(20),
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    let events: any[];
    
    if (ctx.input.sport === 'all') {
      events = await getAllSportsScores();
    } else {
      const config = SPORTS_CONFIG[ctx.input.sport];
      const data = await fetchESPN(config.path);
      events = (data.events || []).map((e: any) => normalizeEvent(e, config.name));
    }
    
    const upcoming = events
      .filter(e => e.status.type === 'STATUS_SCHEDULED' && !e.status.completed)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .slice(0, ctx.input.limit);
    
    return {
      output: {
        sport: ctx.input.sport,
        upcomingCount: upcoming.length,
        events: upcoming,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 5: Full Schedule Report ($0.005) ===
addEntrypoint({
  key: 'report',
  description: 'Complete multi-sport schedule with live, completed, and upcoming events',
  input: z.object({
    sports: z.array(z.enum(['ufc', 'boxing', 'nba', 'nfl', 'nhl', 'mlb'])).optional(),
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    const sportsToFetch = ctx.input.sports || ['ufc', 'boxing', 'nba', 'nfl', 'nhl'];
    
    const results = await Promise.all(
      sportsToFetch.map(async (sport) => {
        const config = SPORTS_CONFIG[sport];
        const data = await fetchESPN(config.path);
        const events = (data.events || []).map((e: any) => normalizeEvent(e, config.name));
        
        return {
          sport: config.name,
          live: events.filter((e: any) => e.status.type === 'STATUS_IN_PROGRESS'),
          completed: events.filter((e: any) => e.status.completed),
          upcoming: events.filter((e: any) => e.status.type === 'STATUS_SCHEDULED'),
        };
      })
    );
    
    const totals = results.reduce(
      (acc, r) => ({
        live: acc.live + r.live.length,
        completed: acc.completed + r.completed.length,
        upcoming: acc.upcoming + r.upcoming.length,
      }),
      { live: 0, completed: 0, upcoming: 0 }
    );
    
    return {
      output: {
        summary: totals,
        bySport: results,
        generatedAt: new Date().toISOString(),
        dataSource: 'ESPN API (live)',
      },
    };
  },
});

// === ANALYTICS ENDPOINTS (FREE) ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms'),
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available', payments: [] } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return {
      output: {
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      },
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50),
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { transactions: [] } };
    }
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

// === Serve icon ===
app.get('/icon.png', async (c) => {
  try {
    const fs = await import('fs');
    const icon = fs.readFileSync('./icon.png');
    return new Response(icon, { headers: { 'Content-Type': 'image/png' } });
  } catch {
    return c.text('Icon not found', 404);
  }
});

// === ERC-8004 Registration File ===
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://sports-scores-agent-production.up.railway.app';
  
  return c.json({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'sports-scores-agent',
    description: 'Real-time sports scores and schedules. 1 free + 5 paid endpoints. Sports: UFC, Boxing, NBA, NFL, NHL, MLB. Data from ESPN.',
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
console.log(`Sports Scores Agent running on port ${port}`);

export default { port, fetch: app.fetch };
