import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiFootballRoot = (process.env.API_FOOTBALL_URL || "https://v3.football.api-sports.io").replace(/\/$/, "");
const apiFootballKey = String(process.env.API_FOOTBALL_KEY || "").trim();
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const team = (name, attack, strength) => ({ name, attack, strength });

function poisson(lambda, k) {
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
}

function probabilityOver(lambda, line) {
  let underOrEqual = 0;
  for (let k = 0; k <= Math.floor(line); k++) underOrEqual += poisson(lambda, k);
  return clamp(1 - underOrEqual, 0, 1);
}

function dixonColesAdjust(homeGoals, awayGoals, homeLambda, awayLambda, rho) {
  if (homeGoals === 0 && awayGoals === 0) return 1 - homeLambda * awayLambda * rho;
  if (homeGoals === 0 && awayGoals === 1) return 1 + homeLambda * rho;
  if (homeGoals === 1 && awayGoals === 0) return 1 + awayLambda * rho;
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1;
}

function seedFrom(values) {
  let hash = 2166136261;
  values.join("|").split("").forEach((character) => {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  });
  return hash >>> 0;
}

function mulberry32(seed) {
  return function random() {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function formStrength(form) {
  const results = String(form || "").toUpperCase().replace(/[^WDL]/g, "").slice(-5);
  if (!results.length) return 0.5;
  return [...results].reduce((sum, result) => sum + (result === "W" ? 1 : result === "D" ? 0.5 : 0), 0) / results.length;
}

function headToHeadStrength(fixture) {
  if (!fixture.h2h.length) return 0;
  const points = fixture.h2h.reduce((sum, match) => {
    const currentHomeWasHome = String(match.homeId) === String(fixture.homeId);
    const homeGoals = currentHomeWasHome ? Number(match.homeGoals) : Number(match.awayGoals);
    const awayGoals = currentHomeWasHome ? Number(match.awayGoals) : Number(match.homeGoals);
    return sum + (homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0);
  }, 0);
  return clamp((points / fixture.h2h.length - 0.5) * 2, -1, 1);
}

async function loadTeamDatabase() {
  const candidates = [path.join(root, "index.html"), path.join(root, "outputs", "lesh-elite-app", "index.html")];
  for (const candidate of candidates) {
    try {
      const html = await readFile(candidate, "utf8");
      const start = html.indexOf("const WORLD_LEAGUES =") + "const WORLD_LEAGUES =".length;
      const end = html.indexOf("\n\n    const ids", start);
      if (start < "const WORLD_LEAGUES =".length || end < 0) continue;
      const expression = html.slice(start, end).trim().replace(/;$/, "");
      return Function("team", `return (${expression});`)(team);
    } catch {}
  }
  return {};
}

function normalizeFixture(source, event) {
  const competition = event.competitions?.[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find((item) => item.homeAway === "home");
  const away = competitors.find((item) => item.homeAway === "away");
  if (!home?.team?.displayName || !away?.team?.displayName) return null;
  const eventDate = event.date || competition.date || "";
  return {
    sourceId: `${source.slug}:${event.id}`,
    provider: source.provider || "espn",
    trackingKey: [source.country, source.league, home.team.displayName, away.team.displayName, eventDate.slice(0, 10)].join("|"),
    eventId: String(event.id),
    eventDate,
    slug: source.slug,
    country: source.country,
    league: source.league,
    home: home.team.displayName,
    away: away.team.displayName,
    homeId: String(home.team.id || ""),
    awayId: String(away.team.id || ""),
    homeForm: home.form || "",
    awayForm: away.form || "",
    h2h: Array.isArray(event.h2h) ? event.h2h : [],
    matchState: competition.status?.type?.state || "pre",
    homeScore: Number(home.score) || 0,
    awayScore: Number(away.score) || 0
  };
}

function predict(fixture, leagues) {
  const profiles = leagues[fixture.country]?.[fixture.league] || [];
  const home = profiles.find((item) => item.name === fixture.home) || team(fixture.home, 1.32, 1625);
  const away = profiles.find((item) => item.name === fixture.away) || team(fixture.away, 1.32, 1625);
  const formEdge = formStrength(fixture.homeForm) - formStrength(fixture.awayForm);
  const h2hEdge = headToHeadStrength(fixture);
  const random = mulberry32(seedFrom([fixture.sourceId, fixture.home, fixture.away]));
  const pressure = clamp(54 + (home.attack - away.attack) * 15 + (home.strength - away.strength) / 26 + formEdge * 10, 28, 84) / 100;
  const weakness = clamp(47 + (1710 - (home.strength + away.strength) / 2) / 24 + Math.max(0, away.attack - home.attack) * 10, 28, 74) / 100;
  const tempo = clamp(48 + (home.attack + away.attack - 2.7) * 13 + Math.abs(formEdge) * 6, 34, 78) / 100;
  const aggression = (43 + random() * 23) / 100;
  const referee = (45 + random() * 20) / 100;
  const eloHomeWin = 1 / (1 + Math.pow(10, ((away.strength - (home.strength + 65)) / 400)));
  const eloSwing = clamp((eloHomeWin - 0.5) * 0.58 + formEdge * 0.16 + h2hEdge * 0.08, -0.45, 0.45);
  const disciplineDrag = 1 - aggression * referee * 0.08;
  const homeLambda = clamp(home.attack * (0.82 + tempo * 0.36) * (0.9 + pressure * 0.28) * (1 + eloSwing) * (0.96 + weakness * 0.14) * disciplineDrag, 0.05, 5.8);
  const awayLambda = clamp(away.attack * (0.82 + tempo * 0.36) * (0.9 + weakness * 0.34) * (1 - eloSwing * 0.82) * (1.03 - pressure * 0.11) * disciplineDrag, 0.05, 5.8);
  const rho = -0.09 + (tempo - 0.5) * 0.05;
  let homeWin = 0, draw = 0, awayWin = 0, over25 = 0, btts = 0;
  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      const probability = poisson(homeLambda, h) * poisson(awayLambda, a) * Math.max(0.01, dixonColesAdjust(h, a, homeLambda, awayLambda, rho));
      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;
      if (h + a > 2.5) over25 += probability;
      if (h > 0 && a > 0) btts += probability;
    }
  }
  const total = homeWin + draw + awayWin || 1;
  homeWin /= total; draw /= total; awayWin /= total; over25 /= total; btts /= total;
  const outcomes = [homeWin, draw, awayWin];
  const best = outcomes.indexOf(Math.max(...outcomes));
  const expectedCorners = 7.1 + tempo * 2.2 + pressure * 1.7 + weakness * 1.15 + Math.abs(homeLambda - awayLambda) * 0.55;
  const expectedBookings = 2.2 + aggression * 2.15 + referee * 1.7 + (1 - tempo) * 0.4;
  const marketPredictions = (expected, lines) => lines.map((line) => {
    const overProbability = probabilityOver(expected, line);
    return { line, over: overProbability >= 0.5, probability: Math.max(overProbability, 1 - overProbability) };
  });
  return {
    pick: best === 0 ? "H" : best === 2 ? "A" : "D",
    pickProbability: outcomes[best],
    confidence: Math.round(clamp(54 + (outcomes[best] - 0.34) * 74 + Math.abs(homeLambda - awayLambda) * 5, 48, 94)),
    goalsOver25: over25 >= 0.52,
    goalsProbability: over25,
    bttsYes: btts >= 0.5,
    bttsProbability: btts,
    expectedGoals: homeLambda + awayLambda,
    expectedCorners,
    expectedBookings,
    cornerPredictions: marketPredictions(expectedCorners, [8.5, 9.5, 10.5]),
    bookingPredictions: marketPredictions(expectedBookings, [3.5, 4.5, 5.5])
  };
}

function grade(record, fixture) {
  const actualOutcome = fixture.homeScore > fixture.awayScore ? "H" : fixture.homeScore < fixture.awayScore ? "A" : "D";
  record.status = record.pick === actualOutcome ? "correct" : "incorrect";
  record.outcomeCorrect = record.pick === actualOutcome;
  record.goalsCorrect = record.goalsOver25 === (fixture.homeScore + fixture.awayScore > 2.5);
  record.bttsCorrect = record.bttsYes === (fixture.homeScore > 0 && fixture.awayScore > 0);
  record.finalScore = `${fixture.homeScore}-${fixture.awayScore}`;
  record.gradedAt = new Date().toISOString();
}

function numericStat(stat) {
  const value = stat?.value ?? stat?.displayValue;
  const number = Number.parseFloat(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : null;
}

async function fetchEspnMarketStats(fixture) {
  const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${fixture.slug}/summary?event=${fixture.eventId}`, {
    headers: { "user-agent": "Lesh-Elite-Prediction-Grader/1.0" },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`ESPN summary ${fixture.eventId}: ${response.status}`);
  const data = await response.json();
  const statistics = (data.boxscore?.teams || []).flatMap((team) => team.statistics || []);
  const totalFor = (names) => {
    const matches = statistics.filter((stat) => names.includes(String(stat.name || stat.label || "").toLowerCase()));
    return matches.length ? matches.reduce((sum, stat) => sum + (numericStat(stat) || 0), 0) : null;
  };
  const corners = totalFor(["cornerkicks", "corner kicks", "corners"]);
  const yellow = totalFor(["yellowcards", "yellow cards"]);
  const red = totalFor(["redcards", "red cards"]);
  return corners === null && yellow === null && red === null ? null : {
    corners,
    bookings: yellow === null && red === null ? null : (yellow || 0) + (red || 0)
  };
}

async function fetchApiFootballMarketStats(fixture) {
  if (!apiFootballKey) return null;
  const response = await fetch(`${apiFootballRoot}/fixtures/statistics?fixture=${fixture.eventId}`, {
    headers: { "x-apisports-key": apiFootballKey },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`API-Football statistics ${fixture.eventId}: ${response.status}`);
  const data = await response.json();
  const errors = data.errors && (Array.isArray(data.errors) ? data.errors.length : Object.keys(data.errors).length);
  if (errors) throw new Error(`API-Football statistics ${fixture.eventId} returned an API error`);
  const statistics = (data.response || []).flatMap((team) => team.statistics || []);
  const totalFor = (type) => {
    const matches = statistics.filter((stat) => stat.type === type);
    return matches.length ? matches.reduce((sum, stat) => sum + (numericStat(stat) || 0), 0) : null;
  };
  const corners = totalFor("Corner Kicks");
  const yellow = totalFor("Yellow Cards");
  const red = totalFor("Red Cards");
  return corners === null && yellow === null && red === null ? null : {
    corners,
    bookings: yellow === null && red === null ? null : (yellow || 0) + (red || 0)
  };
}

async function gradeMarkets(record, fixture) {
  const lastAttempt = Date.parse(record.marketStatsAttemptedAt || "") || 0;
  if (Date.now() - lastAttempt < 12 * 60 * 60 * 1000) return;
  record.marketStatsAttemptedAt = new Date().toISOString();
  try {
    const stats = fixture.provider === "api-football"
      ? await fetchApiFootballMarketStats(fixture)
      : await fetchEspnMarketStats(fixture);
    if (!stats) return;
    record.actualCorners = stats.corners;
    record.actualBookings = stats.bookings;
    if (Number.isFinite(stats.corners)) {
      record.cornerResults = (record.cornerPredictions || []).map((prediction) => ({
        ...prediction,
        correct: prediction.over === (stats.corners > prediction.line)
      }));
    }
    if (Number.isFinite(stats.bookings)) {
      record.bookingResults = (record.bookingPredictions || []).map((prediction) => ({
        ...prediction,
        correct: prediction.over === (stats.bookings > prediction.line)
      }));
    }
    record.marketGradedAt = new Date().toISOString();
  } catch (error) {
    console.warn(`Market statistics unavailable for ${fixture.trackingKey}: ${error}`);
  }
}

const fixturesPayload = JSON.parse(await readFile(path.join(root, "fixtures.json"), "utf8"));
const leagues = await loadTeamDatabase();
const fixtures = (fixturesPayload.sources || []).flatMap((source) =>
  (source.events || []).map((event) => normalizeFixture(source, event)).filter(Boolean)
);
let records = [];
try {
  const existing = JSON.parse(await readFile(path.join(root, "predictions.json"), "utf8"));
  records = Array.isArray(existing.predictions) ? existing.predictions : [];
} catch {}

fixtures.filter((fixture) => fixture.matchState === "pre").forEach((fixture) => {
  if (records.some((record) => record.trackingKey === fixture.trackingKey)) return;
  records.unshift({ ...fixture, ...predict(fixture, leagues), automatic: true, savedAt: new Date().toISOString(), status: "pending" });
});

records.forEach((record) => {
  if (record.cornerPredictions?.length && record.bookingPredictions?.length) return;
  const fixture = fixtures.find((item) => item.trackingKey === record.trackingKey);
  if (!fixture) return;
  const markets = predict(fixture, leagues);
  record.expectedCorners = markets.expectedCorners;
  record.expectedBookings = markets.expectedBookings;
  record.cornerPredictions = markets.cornerPredictions;
  record.bookingPredictions = markets.bookingPredictions;
});

records.filter((record) => record.status === "pending").forEach((record) => {
  const fixture = fixtures.find((item) => item.trackingKey === record.trackingKey && item.matchState === "post");
  if (fixture) grade(record, fixture);
});

for (const record of records) {
  if (record.cornerResults?.length && record.bookingResults?.length) continue;
  const fixture = fixtures.find((item) => item.trackingKey === record.trackingKey && item.matchState === "post");
  if (fixture) await gradeMarkets(record, fixture);
}

records = records.sort((a, b) => new Date(b.eventDate) - new Date(a.eventDate)).slice(0, 500);
const payload = { updatedAt: new Date().toISOString(), version: 1, predictions: records };
await writeFile(path.join(root, "predictions.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Published ${records.length} shared predictions; ${records.filter((item) => item.status !== "pending").length} graded.`);
