import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const API_URL = "https://v3.football.api-sports.io";
const LEAGUE_ID = "1";
const SEASON = "2026";
const TIMEZONE = "America/Sao_Paulo";

function normalize(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(de|da|do|dos|das|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const aliases = new Map([
  ["southafrica", "africadosul"],
  ["korearepublic", "coreiadosul"],
  ["southkorea", "coreiadosul"],
  ["czechia", "republicatcheca"],
  ["czechrepublic", "republicatcheca"],
  ["bosniaherzegovina", "bosniaeherzegovina"],
  ["unitedstates", "estadosunidos"],
  ["usa", "estadosunidos"],
  ["netherlands", "holanda"],
  ["ivorycoast", "costadomarfim"],
  ["cotedivoire", "costadomarfim"],
  ["capeverde", "caboverde"],
  ["newzealand", "novazelandia"],
  ["saudiarabia", "arabiasaudita"],
  ["drc", "republicademocraticacongo"],
  ["drcongo", "republicademocraticacongo"],
  ["congodr", "republicademocraticacongo"],
  ["democraticrepubliccongo", "republicademocraticacongo"],
  ["curacao", "curacao"],
  ["qatar", "catar"],
  ["turkiye", "turquia"],
  ["morocco", "marrocos"],
  ["switzerland", "suica"],
  ["germany", "alemanha"],
  ["japan", "japao"],
  ["tunisia", "tunisia"],
  ["belgium", "belgica"],
  ["egypt", "egito"],
  ["iran", "ira"],
  ["spain", "espanha"],
  ["uruguay", "uruguai"],
  ["france", "franca"],
  ["iraq", "iraque"],
  ["norway", "noruega"],
  ["algeria", "argelia"],
  ["austria", "austria"],
  ["jordan", "jordania"],
  ["england", "inglaterra"],
  ["croatia", "croacia"],
  ["colombia", "colombia"],
  ["uzbekistan", "uzbequistao"],
  ["ghana", "gana"],
  ["panama", "panama"],
  ["scotland", "escocia"],
  ["haiti", "haiti"],
  ["senegal", "senegal"],
  ["portugal", "portugal"],
  ["paraguay", "paraguai"],
  ["australia", "australia"],
  ["canada", "canada"],
  ["mexico", "mexico"],
  ["brazil", "brasil"],
  ["ecuador", "equador"],
  ["sweden", "suecia"]
]);

function teamKey(name) {
  const key = normalize(name);
  return aliases.get(key) || key;
}

function appStatus(short) {
  if (["FT", "AET", "PEN"].includes(short)) return "closed";
  if (["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT"].includes(short)) return "live";
  return "pre";
}

function brazilDate(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT não configurada.");
  const parsed = JSON.parse(raw);
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}

if (!getApps().length) {
  initializeApp({ credential: cert(getServiceAccount()) });
}
const db = getFirestore();

async function fetchFixtures(date) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error("API_FOOTBALL_KEY não configurada.");

  const url = `${API_URL}/fixtures?league=${LEAGUE_ID}&season=${SEASON}&date=${date}&timezone=${encodeURIComponent(TIMEZONE)}`;
  const response = await fetch(url, {
    headers: { "x-apisports-key": key }
  });

  if (!response.ok) {
    throw new Error(`API-Football respondeu ${response.status}`);
  }

  const data = await response.json();
  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(`Erro da API-Football: ${JSON.stringify(data.errors)}`);
  }
  return data.response || [];
}

async function updateMatches(fixtures) {
  const snap = await db.collection("matches").get();
  const docs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  let updated = 0;

  for (const fixture of fixtures) {
    const apiHome = teamKey(fixture.teams?.home?.name);
    const apiAway = teamKey(fixture.teams?.away?.name);

    const match = docs.find(m =>
      teamKey(m.home) === apiHome && teamKey(m.away) === apiAway
    );

    if (!match) continue;

    const short = fixture.fixture?.status?.short || "NS";
    const status = appStatus(short);
    const homeGoals = Number(fixture.goals?.home ?? 0);
    const awayGoals = Number(fixture.goals?.away ?? 0);
    const htHome = Number(fixture.score?.halftime?.home ?? 0);
    const htAway = Number(fixture.score?.halftime?.away ?? 0);
    const minute = fixture.fixture?.status?.elapsed;

    await db.collection("matches").doc(match.id).update({
      scoreHome: homeGoals,
      scoreAway: awayGoals,
      htScoreHome: htHome,
      htScoreAway: htAway,
      minute: minute == null ? "" : String(minute),
      status,
      bettingOpen: status === "pre" ? Boolean(match.bettingOpen) : false,
      apiFixtureId: fixture.fixture?.id || null,
      apiStatus: short,
      updatedAt: FieldValue.serverTimestamp()
    });

    updated++;
  }

  return updated;
}

export default async () => {
  try {
    // Consulta hoje e amanhã para cobrir partidas que atravessam a meia-noite.
    const dates = [brazilDate(0), brazilDate(1)];
    const results = [];

    for (const date of dates) {
      const fixtures = await fetchFixtures(date);
      results.push(...fixtures);
    }

    const unique = Array.from(
      new Map(results.map(item => [item.fixture?.id, item])).values()
    );

    const updated = await updateMatches(unique);

    return new Response(
      JSON.stringify({
        ok: true,
        fixturesFound: unique.length,
        matchesUpdated: updated,
        checkedAt: new Date().toISOString()
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (error) {
    console.error(error);
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
};

export const config = {
  schedule: "*/15 * * * *"
};
