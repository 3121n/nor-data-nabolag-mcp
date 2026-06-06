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
// NIBIO FKB-AR5 WMS — GetFeatureInfo-punktoppslag (MapServer: GML, ikke JSON).
// ---------------------------------------------------------------------------

const AR5_WMS = "https://wms.nibio.no/cgi-bin/ar5";

type Ar5Punkt = {
  artype?: string;
  beskrivelse?: string;
  treslag?: string;
  arealDekar?: number;
  verifiseringsdato?: string;
  klassifiseringsmetode?: string;
};

function gmlTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m?.[1] || undefined;
}

async function ar5Arealtype(lat: number, lon: number): Promise<Ar5Punkt | null> {
  const dLat = 0.002;
  const dLon = 0.004;
  const url = new URL(AR5_WMS);
  url.searchParams.set("SERVICE", "WMS");
  url.searchParams.set("VERSION", "1.3.0");
  url.searchParams.set("REQUEST", "GetFeatureInfo");
  url.searchParams.set("LAYERS", "Arealtype");
  url.searchParams.set("QUERY_LAYERS", "Arealtype");
  url.searchParams.set("CRS", "EPSG:4326");
  url.searchParams.set("BBOX", `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon}`);
  url.searchParams.set("WIDTH", "101");
  url.searchParams.set("HEIGHT", "101");
  url.searchParams.set("I", "50");
  url.searchParams.set("J", "50");
  url.searchParams.set("INFO_FORMAT", "application/vnd.ogc.gml");
  url.searchParams.set("FEATURE_COUNT", "1");
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`NIBIO AR5 ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  if (xml.includes("ServiceException")) {
    throw new Error(`NIBIO AR5 ServiceException: ${xml.slice(0, 200)}`);
  }
  if (!xml.includes("<Arealtype_feature>")) return null;
  const arealDa = Number(gmlTag(xml, "areal_da"));
  return {
    artype: gmlTag(xml, "artype"),
    beskrivelse: gmlTag(xml, "artype_beskrivelse"),
    treslag: gmlTag(xml, "artreslag_beskrivelse"),
    arealDekar: Number.isFinite(arealDa) ? arealDa : undefined,
    verifiseringsdato: gmlTag(xml, "verifiseringsdato"),
    klassifiseringsmetode: gmlTag(xml, "klassifiseringsmetode"),
  };
}

// ---------------------------------------------------------------------------
// SSB Offentlige grøntområder (parker og turområder) — WFS GetFeature, GML 3.2.
// Featurene er navnløse polygoner med areal (dekar), kommune- og tettstedsnr.
// ---------------------------------------------------------------------------

const SSB_PARKER_WFS = "https://kart.ssb.no/api/mapserver/v1/wfs/parker_og_turomraader";
const SSB_PARKER_TYPENAME = "ms:layer-1b553d";

type ParkTreff = {
  avstandMeter: number;
  innenfor: boolean;
  arealDekar?: number;
  kommunenummer?: string;
};

function haversineMeter(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Ray-casting i grader (godt nok på polygonskala). Ring = [lat,lon]-par. */
function punktIRing(lat: number, lon: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lonI] = ring[i];
    const [latJ, lonJ] = ring[j];
    if (
      lonI > lon !== lonJ > lon &&
      lat < ((latJ - latI) * (lon - lonI)) / (lonJ - lonI) + latI
    ) {
      inside = !inside;
    }
  }
  return inside;
}

async function ssbNaermestePark(lat: number, lon: number): Promise<{ treff: ParkTreff | null; sokteRadiusMeter: number; antallISisteSok: number }> {
  const radier = [250, 500, 1000, 2000];
  for (const radius of radier) {
    const dLat = radius / 111_320;
    const dLon = radius / (111_320 * Math.cos((lat * Math.PI) / 180));
    const url = new URL(SSB_PARKER_WFS);
    url.searchParams.set("service", "WFS");
    url.searchParams.set("version", "2.0.0");
    url.searchParams.set("request", "GetFeature");
    url.searchParams.set("typenames", SSB_PARKER_TYPENAME);
    url.searchParams.set(
      "bbox",
      `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon},urn:ogc:def:crs:EPSG::4258`,
    );
    url.searchParams.set("count", "50");
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`SSB parker-WFS ${res.status} ${res.statusText}`);
    }
    const xml = await res.text();
    if (xml.includes("ExceptionReport")) {
      throw new Error(`SSB parker-WFS Exception: ${xml.slice(0, 200)}`);
    }
    const members = xml.split("<wfs:member>").slice(1);
    if (!members.length) continue;

    let beste: ParkTreff | null = null;
    for (const member of members) {
      const ringer: number[][][] = [];
      for (const pl of member.matchAll(/<gml:posList[^>]*>([^<]+)<\/gml:posList>/g)) {
        const tall = pl[1].trim().split(/\s+/).map(Number);
        const ring: number[][] = [];
        for (let i = 0; i + 1 < tall.length; i += 2) ring.push([tall[i], tall[i + 1]]);
        if (ring.length >= 3) ringer.push(ring);
      }
      if (!ringer.length) continue;
      const innenfor = punktIRing(lat, lon, ringer[0]);
      let minAvstand = innenfor ? 0 : Infinity;
      if (!innenfor) {
        for (const ring of ringer) {
          for (const [vLat, vLon] of ring) {
            const d = haversineMeter(lat, lon, vLat, vLon);
            if (d < minAvstand) minAvstand = d;
          }
        }
      }
      const dekar = Number(gmlTag(member, "ms:dekar"));
      const treff: ParkTreff = {
        avstandMeter: Math.round(minAvstand),
        innenfor,
        arealDekar: Number.isFinite(dekar) ? Math.round(dekar * 10) / 10 : undefined,
        kommunenummer: gmlTag(member, "ms:komm_nr"),
      };
      if (!beste || treff.avstandMeter < beste.avstandMeter) beste = treff;
    }
    if (beste) return { treff: beste, sokteRadiusMeter: radius, antallISisteSok: members.length };
  }
  return { treff: null, sokteRadiusMeter: radier[radier.length - 1], antallISisteSok: 0 };
}

// ---------------------------------------------------------------------------
// MCP-server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "drist-nabolag-mcp", version: "0.2.0" });

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

server.tool(
  "hent_grontareal",
  "Grøntareal rundt et koordinat (WGS84) fra to åpne kilder: (1) FKB-AR5 arealtype på selve punktet (bebygd/skog/dyrka/myr osv., NIBIO) og (2) avstand til nærmeste offentlige park-/turområde (SSB, ekspanderende søk 250 m → 2 km). NB: SSB-polygonene er navnløse og dekker primært tettsteder — 'ingen park' rurally betyr ofte at grøntarealet ER omgivelsene (se AR5-typen). Parkavstand måles til nærmeste polygon-hjørnepunkt (tilnærming). Kilder: NIBIO WMS + SSB WFS, åpne data uten avtale.",
  {
    lat: z.number().min(57).max(72).describe("Breddegrad (WGS84)"),
    lon: z.number().min(4).max(32).describe("Lengdegrad (WGS84)"),
  },
  async ({ lat, lon }) => {
    const [ar5, park] = await Promise.all([
      ar5Arealtype(lat, lon),
      ssbNaermestePark(lat, lon),
    ]);

    const parkTekst = park.treff
      ? park.treff.innenfor
        ? `Punktet ligger I et offentlig park-/turområde (${park.treff.arealDekar ?? "?"} dekar).`
        : `Nærmeste park-/turområde: ${park.treff.avstandMeter} m (${park.treff.arealDekar ?? "?"} dekar).`
      : "Ingen registrert park-/turområde innen 2 km — SSB-datasettet dekker primært tettsteder; i spredtbygde strøk er AR5-arealtypen rundt punktet et bedre grøntsignal.";

    const result = {
      lat,
      lon,
      arealtypePaaPunkt: ar5
        ? {
            kode: ar5.artype,
            betydning: ar5.beskrivelse,
            treslag: ar5.treslag && ar5.treslag !== "Ikke relevant" ? ar5.treslag : undefined,
            figurArealDekar: ar5.arealDekar,
            verifiseringsdato: ar5.verifiseringsdato,
            klassifiseringsmetode: ar5.klassifiseringsmetode,
          }
        : { kode: undefined, betydning: "Ikke kartlagt i AR5 på dette punktet" },
      naermestePark: {
        treff: park.treff !== null,
        ...(park.treff ?? {}),
        sokteRadiusMeter: park.sokteRadiusMeter,
        antallOmraaderISisteSok: park.antallISisteSok,
        merknad: "SSB-polygonene er navnløse (kun areal/kommune/tettsted); avstand er til nærmeste hjørnepunkt på polygonet.",
      },
      sammendrag: `Arealtype på punktet: ${ar5?.beskrivelse ?? "ikke kartlagt"}. ${parkTekst}`,
      kilde: {
        ar5: {
          navn: "NIBIO — FKB-AR5 arealressurskart",
          tjeneste: AR5_WMS,
          lisens: "Åpne data, punktoppslag uten avtale",
        },
        parker: {
          navn: "SSB — Offentlige grøntområder (parker og turområder)",
          tjeneste: SSB_PARKER_WFS,
          lisens: "Åpne data (NLOD), uten avtale",
        },
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
