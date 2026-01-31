import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

const SPORTS = {
  nba: { name: 'NBA', path: 'basketball/nba' },
  nfl: { name: 'NFL', path: 'football/nfl' },
  mlb: { name: 'MLB', path: 'baseball/mlb' },
  nhl: { name: 'NHL', path: 'hockey/nhl' },
  mls: { name: 'MLS', path: 'soccer/usa.1' },
} as const;

type SportKey = keyof typeof SPORTS;

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

async function fetchESPN(path: string) {
  const url = `${ESPN_BASE}/${path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ESPN API error: ${response.status}`);
  return response.json();
}

function parseScoreboard(data: any, sport: string) {
  return (data.events || []).map((event: any) => {
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors || [];
    return {
      id: event.id,
      name: event.name,
      date: event.date,
      status: event.status?.type?.description || 'Unknown',
      venue: competition?.venue?.fullName,
      teams: competitors.map((c: any) => ({
        name: c.team?.displayName,
        abbreviation: c.team?.abbreviation,
        score: c.score,
        homeAway: c.homeAway,
        winner: c.winner,
      })),
      sport,
    };
  });
}

function parseTeams(data: any, sport: string) {
  const league = data.sports?.[0]?.leagues?.[0];
  return (league?.teams || []).map((t: any) => ({
    id: t.team?.id,
    name: t.team?.displayName,
    abbreviation: t.team?.abbreviation,
    location: t.team?.location,
    logo: t.team?.logos?.[0]?.href,
    sport,
  }));
}

const agent = await createAgent({
  name: 'sports-scores-agent',
  version: '1.0.0',
  description: 'Live sports scores, standings, and schedules from ESPN. Covers NBA, NFL, MLB, NHL, and MLS.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === FREE: Overview of today's games across all sports ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview of live/upcoming games across NBA, NFL, MLB, NHL, MLS',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const results = await Promise.all(
      Object.entries(SPORTS).map(async ([key, sport]) => {
        try {
          const data = await fetchESPN(`${sport.path}/scoreboard`);
          const games = parseScoreboard(data, sport.name);
          return { sport: sport.name, gameCount: games.length, games: games.slice(0, 2) };
        } catch {
          return { sport: sport.name, gameCount: 0, games: [] };
        }
      })
    );
    return {
      output: {
        summary: results,
        totalGames: results.reduce((sum, r) => sum + r.gameCount, 0),
        fetchedAt: new Date().toISOString(),
        dataSource: 'ESPN API (live)',
      },
    };
  },
});

// === PAID 1: Live scores for a specific sport ($0.001) ===
addEntrypoint({
  key: 'scores',
  description: 'Get live scores for a specific sport',
  input: z.object({
    sport: z.enum(['nba', 'nfl', 'mlb', 'nhl', 'mls']),
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const sport = SPORTS[ctx.input.sport as SportKey];
    const data = await fetchESPN(`${sport.path}/scoreboard`);
    const games = parseScoreboard(data, sport.name);
    return {
      output: {
        sport: sport.name,
        games,
        gameCount: games.length,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID 2: Teams and standings ($0.002) ===
addEntrypoint({
  key: 'teams',
  description: 'Get all teams for a sport with basic info',
  input: z.object({
    sport: z.enum(['nba', 'nfl', 'mlb', 'nhl', 'mls']),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const sport = SPORTS[ctx.input.sport as SportKey];
    const data = await fetchESPN(`${sport.path}/teams`);
    const teams = parseTeams(data, sport.name);
    return {
      output: {
        sport: sport.name,
        teams,
        teamCount: teams.length,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID 3: Upcoming schedule ($0.002) ===
addEntrypoint({
  key: 'schedule',
  description: 'Get upcoming games schedule for a sport',
  input: z.object({
    sport: z.enum(['nba', 'nfl', 'mlb', 'nhl', 'mls']),
    days: z.number().min(1).max(7).optional().default(3),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const sport = SPORTS[ctx.input.sport as SportKey];
    const dates: string[] = [];
    const now = new Date();
    for (let i = 0; i < ctx.input.days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      dates.push(d.toISOString().split('T')[0].replace(/-/g, ''));
    }
    
    const allGames = await Promise.all(
      dates.map(async (date) => {
        try {
          const data = await fetchESPN(`${sport.path}/scoreboard?dates=${date}`);
          return parseScoreboard(data, sport.name);
        } catch {
          return [];
        }
      })
    );
    
    const games = allGames.flat();
    return {
      output: {
        sport: sport.name,
        schedule: games,
        gameCount: games.length,
        daysAhead: ctx.input.days,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID 4: Specific game details ($0.003) ===
addEntrypoint({
  key: 'game',
  description: 'Get detailed info for a specific game by ID',
  input: z.object({
    sport: z.enum(['nba', 'nfl', 'mlb', 'nhl', 'mls']),
    gameId: z.string(),
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const sport = SPORTS[ctx.input.sport as SportKey];
    const data = await fetchESPN(`${sport.path}/summary?event=${ctx.input.gameId}`);
    
    const boxscore = data.boxscore;
    const gameInfo = data.gameInfo;
    const header = data.header;
    
    return {
      output: {
        gameId: ctx.input.gameId,
        sport: sport.name,
        name: header?.competitions?.[0]?.competitors?.map((c: any) => c.team?.displayName).join(' vs '),
        status: header?.competitions?.[0]?.status?.type?.description,
        venue: gameInfo?.venue?.fullName,
        attendance: gameInfo?.attendance,
        teams: header?.competitions?.[0]?.competitors?.map((c: any) => ({
          name: c.team?.displayName,
          score: c.score,
          record: c.record?.[0]?.displayValue,
          winner: c.winner,
        })),
        leaders: boxscore?.players?.map((p: any) => ({
          team: p.team?.displayName,
          leaders: p.statistics?.[0]?.leaders?.slice(0, 3),
        })),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID 5: Full sport report ($0.005) ===
addEntrypoint({
  key: 'report',
  description: 'Comprehensive report with scores, standings, and news for a sport',
  input: z.object({
    sport: z.enum(['nba', 'nfl', 'mlb', 'nhl', 'mls']),
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    const sport = SPORTS[ctx.input.sport as SportKey];
    
    const [scoreboard, teams, news] = await Promise.all([
      fetchESPN(`${sport.path}/scoreboard`),
      fetchESPN(`${sport.path}/teams`),
      fetchESPN(`${sport.path}/news`).catch(() => ({ articles: [] })),
    ]);
    
    const games = parseScoreboard(scoreboard, sport.name);
    const teamList = parseTeams(teams, sport.name);
    const articles = (news.articles || []).slice(0, 5).map((a: any) => ({
      headline: a.headline,
      description: a.description,
      published: a.published,
      link: a.links?.web?.href,
    }));
    
    return {
      output: {
        sport: sport.name,
        liveGames: games.filter((g: any) => g.status === 'In Progress'),
        todaysGames: games,
        teams: teamList.slice(0, 10),
        latestNews: articles,
        stats: {
          totalTeams: teamList.length,
          gamesInProgress: games.filter((g: any) => g.status === 'In Progress').length,
          gamesScheduled: games.filter((g: any) => g.status === 'Scheduled').length,
          gamesCompleted: games.filter((g: any) => g.status === 'Final').length,
        },
        fetchedAt: new Date().toISOString(),
        dataSource: 'ESPN API (live)',
      },
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🏀 Sports Scores Agent running on port ${port}`);

export default { port, fetch: app.fetch };
