import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const competitions = [
  { country: "International", league: "FIFA World Cup", slug: "fifa.world" },
  { country: "England", league: "Premier League", slug: "eng.1" },
  { country: "England", league: "Championship", slug: "eng.2" },
  { country: "Spain", league: "La Liga", slug: "esp.1" },
  { country: "Spain", league: "Segunda Division", slug: "esp.2" },
  { country: "Italy", league: "Serie A", slug: "ita.1" },
  { country: "Germany", league: "Bundesliga", slug: "ger.1" },
  { country: "France", league: "Ligue 1", slug: "fra.1" },
  { country: "Netherlands", league: "Eredivisie", slug: "ned.1" },
  { country: "Portugal", league: "Primeira Liga", slug: "por.1" },
  { country: "Scotland", league: "Premiership", slug: "sco.1" },
  { country: "Turkey", league: "Super Lig", slug: "tur.1" },
  { country: "Brazil", league: "Serie A", slug: "bra.1" },
  { country: "Argentina", league: "Primera Division", slug: "arg.1" },
  { country: "United States", league: "MLS", slug: "usa.1" },
  { country: "Mexico", league: "Liga MX", slug: "mex.1" },
  { country: "South Africa", league: "Premier Division", slug: "rsa.1" },
  { country: "Egypt", league: "Premier League", slug: "egy.1" },
  { country: "Morocco", league: "Botola Pro", slug: "mar.1" },
  { country: "Saudi Arabia", league: "Saudi Pro League", slug: "ksa.1" },
  { country: "Japan", league: "J1 League", slug: "jpn.1" },
  { country: "South Korea", league: "K League 1", slug: "kor.1" },
  { country: "Australia", league: "A-League Men", slug: "aus.1" }
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scoreboardRoot = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const dateKey = (date) => date.toISOString().slice(0, 10).replaceAll("-", "");
const now = new Date();
const dates = [-1, 0, 1].map((offset) => {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + offset);
  return dateKey(date);
});

async function fetchScoreboard(source, date) {
  const response = await fetch(`${scoreboardRoot}/${source.slug}/scoreboard?dates=${date}`, {
    headers: { "user-agent": "Lesh-Elite-Fixture-Updater/1.0" },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`${source.slug} ${date}: ${response.status}`);
  const data = await response.json();
  return data.events || [];
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

const requests = competitions.flatMap((source) => dates.map((date) => ({ source, date })));
const results = await mapConcurrent(requests, 8, ({ source, date }) => fetchScoreboard(source, date));
const sources = competitions.map((source) => {
  const seen = new Set();
  const events = [];
  requests.forEach((request, index) => {
    if (request.source.slug !== source.slug || results[index].status !== "fulfilled") return;
    results[index].value.forEach((event) => {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      events.push(event);
    });
  });
  return { ...source, events };
});

const payload = {
  updatedAt: new Date().toISOString(),
  dates,
  successfulRequests: results.filter((result) => result.status === "fulfilled").length,
  totalRequests: results.length,
  sources
};

if (payload.successfulRequests === 0) {
  throw new Error("Every fixture request failed; refusing to replace the published feed.");
}

await writeFile(path.join(root, "fixtures.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Wrote ${sources.reduce((sum, source) => sum + source.events.length, 0)} fixtures from ${payload.successfulRequests}/${payload.totalRequests} requests.`);
