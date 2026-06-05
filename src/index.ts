#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Entur JourneyPlanner v3 (GraphQL) — åpne data, krever kun ET-Client-Name.
// ---------------------------------------------------------------------------

const ENTUR_GRAPHQL = "https://api.entur.io/journey-planner/v3/graphql";
const ET_CLIENT_NAME = "drist-nabolag-mcp";

type EnturNearestEdge = {
  node?: {
    distance?: number;
    place?: {
      __typename?: string;
      id?: string;
      name?: string;
      transportMode?: string[];
      quays?: { lines?: { publicCode?: string; name?: string; transportMode?: string }[] }[];
    };
  };
};

const TRANSPORTMODE_NO: Record<string, string> = {
  bus: "buss",
  tram: "trikk",
  metro: "t-bane",
  rail: "tog",
  water: "båt/ferge",
  air: "fly",
  coach: "ekspressbuss",
  funicular: "kabelbane",
  cableway: "taubane",
  lift: "heis",
  trolleybus: "trolleybuss",
  monorail: "monorail",
  unknown: "ukjent",
};

function tilNorskMode(mode: string | undefined): string {
  if (!mode) return "ukjent";
  return TRANSPORTMODE_NO[mode] ?? mode;
}

async function enturNearestStops(
  lat: number,
  lon: number,
  maxDistance: number,
  maxResults: number,
): Promise<EnturNearestEdge[]> {
  const query = `
    query Nearest($lat: Float!, $lon: Float!, $dist: Float!, $n: Int!) {
      nearest(
        latitude: $lat, longitude: $lon,
        maximumDistance: $dist, maximumResults: $n,
        filterByPlaceTypes: [stopPlace]
      ) {
        edges { node { distance place {
          __typename
          ... on StopPlace { id name transportMode quays { lines { publicCode name transportMode } } }
        } } }
      }
    }`;
  const res = await fetch(ENTUR_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ET-Client-Name": ET_CLIENT_NAME,
    },
    body: JSON.stringify({ query, variables: { lat, lon, dist: maxDistance, n: maxResults } }),
  });
  if (!res.ok) {
    throw new Error(`Entur ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    errors?: { message?: string }[];
    data?: { nearest?: { edges?: EnturNearestEdge[] } };
  };
  if (data.errors?.length) {
    throw new Error(`Entur GraphQL-feil: ${data.errors.map((e) => e.message).join("; ")}`);
  }
  return data.data?.nearest?.edges ?? [];
}

// ---------------------------------------------------------------------------
// Statens vegvesen Norstøy WMS — GetFeatureInfo-punktoppslag, åpne data.
// ---------------------------------------------------------------------------

const NORSTOY_WMS = "https://www.vegvesen.no/kart/ogc/norstoy_1_0/ows";

type GeoJsonFeature = { properties?: Record<string, unknown> };

async function norstoyFeatureInfo(layer: string, lat: number, lon: number): Promise<GeoJsonFeature[]> {
  // 101x101-piksel rute med punktet i senterpikselen (I=J=50).
  // WMS 1.3.0 + EPSG:4326 => BBOX i akserekkefølge lat,lon.
  const dLat = 0.002;
  const dLon = 0.004;
  const bbox = `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon}`;
  const url = new URL(NORSTOY_WMS);
  url.searchParams.set("SERVICE", "WMS");
  url.searchParams.set("VERSION", "1.3.0");
  url.searchParams.set("REQUEST", "GetFeatureInfo");
  url.searchParams.set("LAYERS", layer);
  url.searchParams.set("QUERY_LAYERS", layer);
  url.searchParams.set("CRS", "EPSG:4326");
  url.searchParams.set("BBOX", bbox);
  url.searchParams.set("WIDTH", "101");
  url.searchParams.set("HEIGHT", "101");
  url.searchParams.set("I", "50");
  url.searchParams.set("J", "50");
  url.searchParams.set("INFO_FORMAT", "application/json");
  url.searchParams.set("FEATURE_COUNT", "10");
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`SVV Norstøy ${res.status} ${res.statusText} for lag ${layer}`);
  }
  const text = await res.text();
  if (text.includes("ServiceExceptionReport")) {
    throw new Error(`SVV Norstøy ServiceException for lag ${layer}: ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text) as { features?: GeoJsonFeature[] };
  return data.features ?? [];
}

function p(f: GeoJsonFeature, key: string): unknown {
  return f.properties?.[key];
}

const SONEKATEGORI: Record<string, string> = {
  R: "Rød sone (T-1442): frarådes for ny støyfølsom bebyggelse",
  G: "Gul sone (T-1442): vurderingssone — støytiltak kan kreves ved utbygging",
};

/** Kumulative 5 dB-bånd: punkt i både 55 og 60 betyr nivå >= 60. */
function tolkIntervaller(intervaller: number[]): { maks: number; nivaa: string } | null {
  if (!intervaller.length) return null;
  const maks = Math.max(...intervaller);
  return { maks, nivaa: `${maks}–${maks + 4} dB` };
}

// ---------------------------------------------------------------------------
// MCP-server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "drist-nabolag-mcp", version: "0.1.0" });

server.tool(
  "hent_kollektivdekning",
  "Finn kollektivholdeplasser (Entur/nasjonalt stoppestedsregister) rundt et koordinat (WGS84). Returnerer holdeplasser med avstand, transportmidler (buss/trikk/t-bane/tog/båt) og linjer. Dekningen er landsdekkende og komplett — 'ingen treff' betyr reelt ingen holdeplass innen radius. Kilde: Entur JourneyPlanner v3, åpne data (NLOD), ingen avtale.",
  {
    lat: z.number().min(57).max(72).describe("Breddegrad (WGS84, f.eks. 59.93 for Oslo)"),
    lon: z.number().min(4).max(32).describe("Lengdegrad (WGS84, f.eks. 10.76 for Oslo)"),
    maksAvstandMeter: z.number().int().min(50).max(2000).optional()
      .describe("Søkeradius i meter (default 500; bruk 1000-2000 for rurale strøk)"),
    maksTreff: z.number().int().min(1).max(20).optional()
      .describe("Maks antall holdeplasser (default 10)"),
  },
  async ({ lat, lon, maksAvstandMeter, maksTreff }) => {
    const radius = maksAvstandMeter ?? 500;
    const n = maksTreff ?? 10;
    const edges = await enturNearestStops(lat, lon, radius, n);

    const holdeplasser = edges
      .filter((e) => e.node?.place?.__typename === "StopPlace")
      .map((e) => {
        const sp = e.node!.place!;
        const linjeSet = new Map<string, { linje: string; navn?: string; transportmiddel: string }>();
        for (const quay of sp.quays ?? []) {
          for (const line of quay.lines ?? []) {
            const key = `${line.publicCode ?? "?"}|${line.transportMode ?? "?"}`;
            if (!linjeSet.has(key)) {
              linjeSet.set(key, {
                linje: line.publicCode ?? "?",
                navn: line.name,
                transportmiddel: tilNorskMode(line.transportMode),
              });
            }
          }
        }
        return {
          navn: sp.name,
          avstandMeter: Math.round(e.node!.distance ?? -1),
          transportmidler: (sp.transportMode ?? []).map(tilNorskMode),
          linjer: [...linjeSet.values()],
        };
      });

    const alleMidler = [...new Set(holdeplasser.flatMap((h) => h.transportmidler))];
    const alleLinjer = new Set(holdeplasser.flatMap((h) => h.linjer.map((l) => `${l.transportmiddel} ${l.linje}`)));

    const result = {
      lat,
      lon,
      sokeRadiusMeter: radius,
      sammendrag: holdeplasser.length
        ? `${holdeplasser.length} holdeplass(er) innen ${radius} m — nærmeste: ${holdeplasser[0].navn} (${holdeplasser[0].avstandMeter} m). Transportmidler: ${alleMidler.join(", ")}. ${alleLinjer.size} unike linjer.`
        : `Ingen holdeplasser innen ${radius} m. Entur-registeret er landsdekkende, så dette er reell dekningsmangel — prøv større radius for å finne nærmeste.`,
      holdeplasser,
      kilde: {
        navn: "Entur — nasjonalt stoppestedsregister + rutedata for hele Norge",
        tjeneste: ENTUR_GRAPHQL,
        lisens: "Åpne data (NLOD), ingen avtale — kun ET-Client-Name-header",
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "hent_stoysone",
  "Sjekk om et koordinat (WGS84) ligger i Statens vegvesens støysoner: støyvarselkart (T-1442 rød/gul sone, prognoseår) og strategisk støykart (Lden døgn / Lnight natt, 5 dB-intervaller). NB: dekker kun veitrafikk på ERF-veger og storbyområder — 'ingen treff' kan bety under terskel ELLER utenfor kartleggingsomfang (kommunale veier utenfor storby, jernbane og fly inngår ikke; jernbane/lufthavn finnes som egne Geonorge-WFS-er). Kilde: SVV Norstøy WMS, åpne data.",
  {
    lat: z.number().min(57).max(72).describe("Breddegrad (WGS84)"),
    lon: z.number().min(4).max(32).describe("Lengdegrad (WGS84)"),
  },
  async ({ lat, lon }) => {
    const [varsel, lden, lnight] = await Promise.all([
      norstoyFeatureInfo("Stoyvarselkart", lat, lon),
      norstoyFeatureInfo("Strategiskstoykart_lden", lat, lon),
      norstoyFeatureInfo("Strategiskstoykart_lnight", lat, lon),
    ]);

    // Støyvarselkart: nestede soner — R (rød) er strengere enn G (gul).
    const kategorier = varsel.map((f) => String(p(f, "STØYSONEKATEGORI") ?? "")).filter(Boolean);
    const verste = kategorier.includes("R") ? "R" : kategorier.includes("G") ? "G" : null;
    const varselFelt = varsel[0];

    const ldenIntervaller = lden.map((f) => Number(p(f, "STØYINTERVALL"))).filter(Number.isFinite);
    const lnightIntervaller = lnight.map((f) => Number(p(f, "STØYINTERVALL"))).filter(Number.isFinite);
    const ldenTolk = tolkIntervaller(ldenIntervaller);
    const lnightTolk = tolkIntervaller(lnightIntervaller);

    const result = {
      lat,
      lon,
      stoyvarselkart: {
        treff: verste !== null,
        sone: verste,
        betydning: verste ? SONEKATEGORI[verste] : undefined,
        beregnetAar: varselFelt ? p(varselFelt, "BEREGNETÅR") : undefined,
        kildenavn: varselFelt ? p(varselFelt, "STØYKILDENAVN") : undefined,
        forklaring: verste
          ? "Punktet ligger i støyvarselkartets prognosesone for veitrafikk."
          : "Ingen treff i støyvarselkartet — men kartet dekker kun ERF-veger (europa-/riks-/fylkesveg). Stillhet langs kommunale veier kan ikke utledes.",
      },
      strategiskStoykart: {
        lden: ldenTolk
          ? { treff: true, nivaa: ldenTolk.nivaa, intervaller: ldenIntervaller.sort((a, b) => a - b), enhet: "dB Lden (døgnvektet)" }
          : { treff: false },
        lnight: lnightTolk
          ? { treff: true, nivaa: lnightTolk.nivaa, intervaller: lnightIntervaller.sort((a, b) => a - b), enhet: "dB Lnight (natt)" }
          : { treff: false },
        beregnetAar: lden[0] ? p(lden[0], "BEREGNETÅR") : undefined,
        omfang: "ERF-veger med ÅDT > 8200 nasjonalt; i storbyområdene alle ERF-veger og kommunale veger med ÅDT > 500",
      },
      forklaring:
        "Kartlagt støy gjelder KUN veitrafikk fra Statens vegvesens beregninger. 'Ingen treff' kan bety støynivå under laveste kartlagte intervall ELLER at punktet ligger utenfor kartleggingsomfanget — skillet kan ikke avgjøres fra disse kartene alene. Jernbane- og flystøy dekkes ikke her.",
      kilde: {
        navn: "Statens vegvesen — Norstøy (støyvarselkart T-1442 + strategisk støykartlegging)",
        tjeneste: NORSTOY_WMS,
        lisens: "Åpne data, punktoppslag uten avtale",
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
