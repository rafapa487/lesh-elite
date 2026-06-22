import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const team = (name, attack, strength) => ({ name, attack, strength });

function poisson(lambda, k) {
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
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
  return {
    pick: best === 0 ? "H" : best === 2 ? "A" : "D",
    pickProbability: outcomes[best],
    confidence: Math.round(clamp(54 + (outcomes[best] - 0.34) * 74 + Math.abs(homeLambda - awayLambda) * 5, 48, 94)),
    goalsOver25: over25 >= 0.52,
    goalsProbability: over25,
    bttsYes: btts >= 0.5,
    bttsProbability: btts,
    expectedGoals: homeLambda + awayLambda,
    expectedCorners: 7.1 + tempo * 2.2 + pressure * 1.7 + weakness * 1.15 + Math.abs(homeLambda - awayLambda) * 0.55,
    expectedBookings: 2.2 + aggression * 2.15 + referee * 1.7 + (1 - tempo) * 0.4
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

records.filter((record) => record.status === "pending").forEach((record) => {
  const fixture = fixtures.find((item) => item.trackingKey === record.trackingKey && item.matchState === "post");
  if (fixture) grade(record, fixture);
});

records = records.sort((a, b) => new Date(b.eventDate) - new Date(a.eventDate)).slice(0, 500);
const payload = { updatedAt: new Date().toISOString(), version: 1, predictions: records };
await writeFile(path.join(root, "predictions.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Published ${records.length} shared predictions; ${records.filter((item) => item.status !== "pending").length} graded.`);
