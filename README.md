# @drist/nabolag-mcp

MCP-server som wrapper åpne norske nabolagsdata. Bygget for Nabodata-produktet,
gjenbrukbar på tvers (delt personlig MCP-datapipeline).

## Verktøy

### `hent_kollektivdekning(lat, lon, maksAvstandMeter?, maksTreff?)`
Holdeplasser rundt et punkt fra Entur JourneyPlanner v3 (GraphQL): avstand,
transportmidler (buss/trikk/t-bane/tog/båt) og linjer per holdeplass.
Landsdekkende og komplett register — «ingen treff» er reell dekningsmangel.

- Kilde: `api.entur.io/journey-planner/v3/graphql`
- Lisens: åpne data (NLOD); krever kun `ET-Client-Name`-header

### `hent_stoysone(lat, lon)`
Veitrafikkstøy fra Statens vegvesens Norstøy via WMS GetFeatureInfo:

- **Støyvarselkart** — T-1442 rød/gul prognosesone (ERF-veger)
- **Strategisk støykart** — Lden (døgn) og Lnight (natt) i kumulative
  5 dB-intervaller (høyeste trefte intervall = nivåbånd)

Ærlighets-design: «ingen treff» kan bety under terskel ELLER utenfor
kartleggingsomfang (kun ERF-veger + storbyområder; kommunale veier utenfor
storby, jernbane og fly inngår ikke) — output sier dette eksplisitt.

- Kilde: `vegvesen.no/kart/ogc/norstoy_1_0/ows`
- Lisens: åpne data, punktoppslag uten avtale

## Bygg og test

```bash
npm install
npm run build
node test-e2e.mjs   # E2E mot live API-er (Oslo + Sørreisa + Sandvika-kontroll)
```

## Registrering (Claude Code)

```json
"nabolag": {
  "type": "stdio",
  "command": "node",
  "args": ["C:\\Users\\hei\\drist-nabolag-mcp\\dist\\index.js"],
  "env": {}
}
```

## Veikart

Se Gap-kartleggingen (Notion, Nabodata-huben): #3 grøntareal (AR5
GetFeatureInfo + SSB parker), #4 skoler/barnehager (UDIR NSR/NBR v4),
#5 solforhold (horisontprofil fra hent_hoyde). Jernbane-/flystøy som
supplement til `hent_stoysone` via Geonorge WFS.
