# Nabolag MCP — Norwegian neighborhood data for AI agents

> Give your agent ground-truth answers about any Norwegian address: public-transport coverage, road-noise exposure, and green-space access — straight from official open data, no API keys.

## Why this server

- **Property-purchase due diligence.** Drop in coordinates for a listing and let the agent report transit options, whether the home sits in a T-1442 red/yellow road-noise zone, and how close the nearest park is — the boring checks a buyer would otherwise do by hand.
- **Relocation & "where should I live" assistants.** Compare candidate neighborhoods on commute viability (real stops and lines from the national registry), quietness, and access to green areas, all on a consistent national scale.
- **Real-estate listing enrichment.** Batch-annotate listings with structured transit / noise / green-area fields for search filters or auto-generated descriptions.
- **Honest by design.** Every tool distinguishes "below threshold / genuinely no coverage" from "outside the dataset's mapped scope," so an agent never overstates silence as a clean bill of health.

## Tools

| Tool | What it returns |
| --- | --- |
| `hent_kollektivdekning(lat, lon, maksAvstandMeter?, maksTreff?)` | Public-transport stops around a point from Entur's national stop registry: distance, transport modes (bus / tram / metro / rail / boat) and lines per stop, plus a summary. Coverage is nationwide and complete, so "no hits" is a real coverage gap. |
| `hent_stoysone(lat, lon)` | Road-traffic noise from Statens vegvesen: T-1442 red/yellow alert zones and strategic-noise Lden (day) / Lnight (night) 5 dB bands. Output flags that mapping covers only major roads + city areas (rail/air not included). |
| `hent_grontareal(lat, lon)` | Green-area signal from two sources: the FKB-AR5 land-cover type at the point (NIBIO) and distance to the nearest public park / recreation area (SSB, expanding 250 m → 2 km search). |

Coordinates are WGS84 (e.g. Oslo ≈ `59.91, 10.75`). The server validates latitude 57–72 / longitude 4–32 (mainland Norway).

## Install

Run directly with npx (stdio MCP server, no build step):

```bash
npx @nor-data/nabolag-mcp
```

### Claude Desktop / Claude Code (`claude_desktop_config.json` or `.mcp.json`)

```json
{
  "mcpServers": {
    "nabolag": {
      "command": "npx",
      "args": ["-y", "@nor-data/nabolag-mcp"]
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "nabolag": {
      "command": "npx",
      "args": ["-y", "@nor-data/nabolag-mcp"]
    }
  }
}
```

No environment variables or API keys are required — all upstream services are open public APIs.

## Data sources & attribution

All data comes from official Norwegian open-data services, queried live per request:

- **Public transport** — [Entur](https://entur.no) JourneyPlanner v3 (national stop registry + route data). Open data under **NLOD**; requires only an `ET-Client-Name` header (set automatically).
- **Road noise** — [Statens vegvesen](https://www.vegvesen.no) Norstøy WMS (T-1442 noise-alert map + strategic noise mapping). Open data, point queries without an agreement.
- **Land cover** — [NIBIO](https://nibio.no) FKB-AR5 land-resource map (WMS GetFeatureInfo). Open data, point queries without an agreement.
- **Parks & recreation areas** — [SSB / Statistics Norway](https://www.ssb.no) public green-areas dataset (WFS). Open data under **NLOD**.

Attribution to Entur, Statens vegvesen, NIBIO and SSB is required when redistributing results. This server adds value by aggregating and normalizing these sources; it does not own the underlying data.

## Pricing (Apify hosted)

> Pricing placeholder — to be finalized on Apify publication. Planned pay-per-event model: **$0.001 per MCP session start** and **$0.002 per tool call**. Running the server locally via `npx` is free; you pay only the upstream services' (open, free) usage.

## License

MIT. Underlying data remains under its respective open-data licenses (NLOD and equivalent) as listed above.
