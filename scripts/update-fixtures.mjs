import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const competitions = [
  { country: "International", league: "FIFA World Cup", slug: "fifa.world", apiLeagueId: 1 },
  { country: "England", league: "Premier League", slug: "eng.1", apiLeagueId: 39 },
  { country: "England", league: "Championship", slug: "eng.2", apiLeagueId: 40 },
  { country: "Spain", league: "La Liga", slug: "esp.1", apiLeagueId: 140 },
  { country: "Spain", league: "Segunda Division", slug: "esp.2", apiLeagueId: 141 },
  { country: "Italy", league: "Serie A", slug: "ita.1", apiLeagueId: 135 },
  { country: "Germany", league: "Bundesliga", slug: "ger.1", apiLeagueId: 78 },
  { country: "France", league: "Ligue 1", slug: "fra.1", apiLeagueId: 61 },
  { country: "Netherlands", league: "Eredivisie", slug: "ned.1", apiLeagueId: 88 },
  { country: "Portugal", league: "Primeira Liga", slug: "por.1", apiLeagueId: 94 },
  { country: "Scotland", league: "Premiership", slug: "sco.1", apiLeagueId: 179 },
  { country: "Turkey", league: "Super Lig", slug: "tur.1", apiLeagueId: 203 },
  { country: "Brazil", league: "Serie A", slug: "bra.1", apiLeagueId: 71 },
  { country: "Argentina", league: "Primera Division", slug: "arg.1", apiLeagueId: 128 },
  { country: "United States", league: "MLS", slug: "usa.1", apiLeagueId: 253 },
  { country: "Mexico", league: "Liga MX", slug: "mex.1", apiLeagueId: 262 },
  { country: "South Africa", league: "Premier Division", slug: "rsa.1", apiLeagueId: 288 },
  { country: "Egypt", league: "Premier League", slug: "egy.1", apiLeagueId: 233 },
  { country: "Morocco", league: "Botola Pro", slug: "mar.1", apiLeagueId: 200 },
  { country: "Saudi Arabia", league: "Saudi Pro League", slug: "ksa.1", apiLeagueId: 307 },
  { country: "Japan", league: "J1 League", slug: "jpn.1", apiLeagueId: 98 },
  { country: "South Korea", league: "K League 1", slug: "kor.1", apiLeagueId: 292 },
  { country: "Australia", league: "A-League Men", slug: "aus.1", apiLeagueId: 188 }
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scoreboardRoot = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const apiFootballRoot = (process.env.API_FOOTBALL_URL || "https://v3.football.api-sports.io").replace(/\/$/, "");
const apiFootballKey = String(process.env.API_FOOTBALL_KEY || "").trim();
const isoDate = (date) => date.toISOString().slice(0, 10);
const dateKey = (date) => isoDate(date).replace(/-/g, "");
const now = new Date();
const dateObjects = [-1, 0, 1].map((offset) => {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + offset);
  return date;
});
const dates = dateObjects.map(dateKey);

async function fetchScoreboard(source, date) {
  const response = await fetch(`${scoreboardRoot}/${source.slug}/scoreboard?dates=${date}`, {
    headers: { "user-agent": "Lesh-Elite-Fixture-Updater/2.0" },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`${source.slug} ${date}: ${response.status}`);
  const data = await response.json();
  return data.events || [];
}

function normalizeEspnH2HEvent(event) {
  const competition = event.competitions?.[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find((team) => team.homeAway === "home");
  const away = competitors.find((team) => team.homeAway === "away");
  if (!home?.team || !away?.team) return null;
  return {
    id: String(event.id || ""),
    date: event.date || competition.date || "",
    homeId: String(home.team.id || ""),
    awayId: String(away.team.id || ""),
    home: home.team.displayName || home.team.name || "Home",
    away: away.team.displayName || away.team.name || "Away",
    homeGoals: Number(home.score) || 0,
    awayGoals: Number(away.score) || 0
  };
}

async function fetchEspnH2H({ source, event }) {
  const competition = event.competitions?.[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find((team) => team.homeAway === "home");
  const away = competitors.find((team) => team.homeAway === "away");
  const homeId = String(home?.team?.id || "");
  const awayId = String(away?.team?.id || "");
  if (!homeId || !awayId) return [];
  const response = await fetch(`${scoreboardRoot}/${source.slug}/teams/${homeId}/schedule`, {
    headers: { "user-agent": "Lesh-Elite-Fixture-Updater/2.0" },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`ESPN team schedule ${source.slug}:${homeId}: ${response.status}`);
  const data = await response.json();
  return (data.events || [])
    .filter((match) => {
      const matchCompetition = match.competitions?.[0] || {};
      const ids = (matchCompetition.competitors || []).map((team) => String(team.team?.id || ""));
      return matchCompetition.status?.type?.state === "post"
        && ids.includes(awayId)
        && String(match.id) !== String(event.id);
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5)
    .map(normalizeEspnH2HEvent)
    .filter(Boolean);
}

function apiMatchState(shortStatus) {
  if (["FT", "AET", "PEN", "AWD", "WO"].includes(shortStatus)) return "post";
  if (["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"].includes(shortStatus)) return "in";
  return "pre";
}

function normalizeApiFootballFixture(item, h2h = []) {
  const state = apiMatchState(item.fixture?.status?.short);
  const elapsed = item.fixture?.status?.elapsed;
  const shortDetail = item.fixture?.status?.short || "Scheduled";
  const homeScore = item.goals?.home ?? 0;
  const awayScore = item.goals?.away ?? 0;
  const competitor = (side, homeAway, score) => ({
    id: String(side?.id || ""),
    homeAway,
    score: String(score),
    winner: side?.winner,
    form: "",
    records: [],
    team: {
      id: String(side?.id || ""),
      displayName: side?.name || (homeAway === "home" ? "Home" : "Away"),
      shortDisplayName: side?.name || "",
      name: side?.name || "",
      logo: side?.logo || ""
    }
  });

  return {
    id: String(item.fixture?.id || ""),
    uid: `api-football:${item.fixture?.id || ""}`,
    date: item.fixture?.date,
    name: `${item.teams?.away?.name || "Away"} at ${item.teams?.home?.name || "Home"}`,
    shortName: `${item.teams?.away?.name || "Away"} @ ${item.teams?.home?.name || "Home"}`,
    h2h,
    competitions: [{
      id: String(item.fixture?.id || ""),
      date: item.fixture?.date,
      status: {
        displayClock: Number.isFinite(elapsed) ? `${elapsed}'` : shortDetail,
        type: {
          state,
          completed: state === "post",
          description: item.fixture?.status?.long || shortDetail,
          shortDetail
        }
      },
      venue: item.fixture?.venue || {},
      altGameNote: item.league?.round || item.league?.name || "Scheduled",
      competitors: [
        competitor(item.teams?.home, "home", homeScore),
        competitor(item.teams?.away, "away", awayScore)
      ]
    }]
  };
}

function normalizeH2HFixture(item) {
  return {
    id: String(item.fixture?.id || ""),
    date: item.fixture?.date || "",
    homeId: String(item.teams?.home?.id || ""),
    awayId: String(item.teams?.away?.id || ""),
    home: item.teams?.home?.name || "Home",
    away: item.teams?.away?.name || "Away",
    homeGoals: Number(item.goals?.home) || 0,
    awayGoals: Number(item.goals?.away) || 0
  };
}

async function fetchApiFootballH2H(item) {
  const homeId = item.teams?.home?.id;
  const awayId = item.teams?.away?.id;
  if (!homeId || !awayId) return [];
  const to = isoDate(now);
  const fromDate = new Date(now);
  fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 2);
  const response = await fetch(`${apiFootballRoot}/fixtures?team=${homeId}&from=${isoDate(fromDate)}&to=${to}`, {
    headers: { "x-apisports-key": apiFootballKey },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`API-Football team history ${homeId}: ${response.status}`);
  const data = await response.json();
  const errors = data.errors && (Array.isArray(data.errors) ? data.errors.length : Object.keys(data.errors).length);
  if (errors) throw new Error(`API-Football team history ${homeId} error: ${JSON.stringify(data.errors)}`);
  return (Array.isArray(data.response) ? data.response : [])
    .filter((match) => {
      const teamIds = [String(match.teams?.home?.id || ""), String(match.teams?.away?.id || "")];
      return apiMatchState(match.fixture?.status?.short) === "post"
        && teamIds.includes(String(awayId))
        && String(match.fixture?.id) !== String(item.fixture?.id);
    })
    .sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date))
    .slice(0, 5)
    .map(normalizeH2HFixture);
}

async function fetchApiFootballDate(date) {
  const response = await fetch(`${apiFootballRoot}/fixtures?date=${isoDate(date)}`, {
    headers: { "x-apisports-key": apiFootballKey },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`API-Football ${isoDate(date)}: ${response.status}`);
  const data = await response.json();
  const errors = data.errors && (Array.isArray(data.errors) ? data.errors.length : Object.keys(data.errors).length);
  if (errors) throw new Error(`API-Football ${isoDate(date)} returned an API error`);
  return Array.isArray(data.response) ? data.response : [];
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: "fulfilled", value: await mapper(items[index]) };
      } catch (error) {
        results[index] = { status: "rejected", reason: String(error) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const espnRequests = competitions.flatMap((source) => dates.map((date) => ({ source, date })));
const espnResults = await mapConcurrent(espnRequests, 8, ({ source, date }) => fetchScoreboard(source, date));
const espnEventsBySlug = new Map(competitions.map((source) => [source.slug, []]));

espnRequests.forEach((request, index) => {
  if (espnResults[index].status !== "fulfilled") return;
  espnEventsBySlug.get(request.source.slug).push(...espnResults[index].value);
});

const espnH2HTargets = competitions.flatMap((source) =>
  (espnEventsBySlug.get(source.slug) || [])
    .filter((event) => isoDate(new Date(event.date)) === isoDate(now))
    .map((event) => ({ source, event }))
);
const espnH2HResults = await mapConcurrent(espnH2HTargets, 5, fetchEspnH2H);
espnH2HResults.forEach((result, index) => {
  if (result.status === "fulfilled") espnH2HTargets[index].event.h2h = result.value;
  else console.warn(`ESPN H2H unavailable for ${espnH2HTargets[index].event.id}: ${result.reason}`);
});

let apiFootballResults = [];
const apiEventsByLeague = new Map();
let h2hRequests = 0;
let h2hSuccessful = 0;
if (apiFootballKey) {
  apiFootballResults = await mapConcurrent(dateObjects, 2, fetchApiFootballDate);
  let previousH2H = new Map();
  try {
    const previousPayload = JSON.parse(await readFile(path.join(root, "fixtures.json"), "utf8"));
    previousH2H = new Map((previousPayload.sources || []).flatMap((source) => source.events || [])
      .filter((event) => Array.isArray(event.h2h) && event.h2h.length)
      .map((event) => [String(event.id), event.h2h]));
  } catch {}

  const apiItems = apiFootballResults
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value)
    .filter((item) => competitions.some((source) => source.apiLeagueId === Number(item.league?.id)));
  const todayItemsMissingH2H = apiItems.filter((item) =>
    isoDate(new Date(item.fixture?.date)) === isoDate(now) && !previousH2H.has(String(item.fixture?.id))
  );
  h2hRequests = todayItemsMissingH2H.length;
  const h2hResults = await mapConcurrent(todayItemsMissingH2H, 2, fetchApiFootballH2H);
  h2hResults.forEach((result, index) => {
    if (result.status !== "fulfilled") {
      console.warn(`H2H unavailable for fixture ${todayItemsMissingH2H[index].fixture?.id}: ${result.reason}`);
      return;
    }
    h2hSuccessful += 1;
    previousH2H.set(String(todayItemsMissingH2H[index].fixture?.id), result.value);
  });

  apiFootballResults.forEach((result) => {
    if (result.status !== "fulfilled") return;
    result.value.forEach((item) => {
      const leagueId = Number(item.league?.id);
      if (!competitions.some((source) => source.apiLeagueId === leagueId)) return;
      if (!apiEventsByLeague.has(leagueId)) apiEventsByLeague.set(leagueId, []);
      apiEventsByLeague.get(leagueId).push(normalizeApiFootballFixture(item, previousH2H.get(String(item.fixture?.id)) || []));
    });
  });
}

function uniqueEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    if (!event.id || seen.has(String(event.id))) return false;
    seen.add(String(event.id));
    return true;
  });
}

const sources = competitions.map((source) => {
  const apiEvents = uniqueEvents(apiEventsByLeague.get(source.apiLeagueId) || []);
  const espnEvents = uniqueEvents(espnEventsBySlug.get(source.slug) || []);
  return {
    country: source.country,
    league: source.league,
    slug: source.slug,
    provider: apiEvents.length ? "api-football" : "espn",
    events: apiEvents.length ? apiEvents : espnEvents
  };
});

const apiSuccessful = apiFootballResults.filter((result) => result.status === "fulfilled").length;
const espnSuccessful = espnResults.filter((result) => result.status === "fulfilled").length;
const apiFixtureCount = sources.filter((source) => source.provider === "api-football")
  .reduce((sum, source) => sum + source.events.length, 0);
const payload = {
  updatedAt: new Date().toISOString(),
  dates,
  provider: apiFixtureCount > 0 ? "api-football+espn" : "espn",
  successfulRequests: espnSuccessful + apiSuccessful + h2hSuccessful,
  totalRequests: espnResults.length + apiFootballResults.length + h2hRequests,
  providers: {
    apiFootball: {
      configured: Boolean(apiFootballKey),
      successfulRequests: apiSuccessful,
      totalRequests: apiFootballResults.length + h2hRequests,
      fixtureCount: apiFixtureCount,
      h2hSuccessfulRequests: h2hSuccessful,
      h2hTotalRequests: h2hRequests
    },
    espn: {
      successfulRequests: espnSuccessful,
      totalRequests: espnResults.length
    }
  },
  sources
};

if (payload.successfulRequests === 0) {
  throw new Error("Every fixture request failed; refusing to replace the published feed.");
}

await writeFile(path.join(root, "fixtures.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
const fixtureCount = sources.reduce((sum, source) => sum + source.events.length, 0);
console.log(`Wrote ${fixtureCount} fixtures using ${payload.provider}. API-Football key configured: ${Boolean(apiFootballKey)}.`);
