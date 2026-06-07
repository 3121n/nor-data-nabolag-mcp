# @nor-data/nabolag-mcp

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

### `hent_grontareal(lat, lon)` (v0.2.0)
Grøntareal fra to kilder: (1) FKB-AR5 arealtype på punktet (NIBIO WMS
GetFeatureInfo, GML — MapServer støtter ikke JSON-infoformat) og
(2) avstand til nærmeste offentlige park-/turområde (SSB WFS, ekspanderende
søk 250 m → 2 km, punkt-i-polygon + nærmeste-hjørne-avstand).

Ærlighets-design: SSB-polygonene er navnløse og dekker primært tettsteder;
i spredtbygde strøk pekes det til AR5-typen som bedre grøntsignal.

- Kilder: `wms.nibio.no/cgi-bin/ar5` + `kart.ssb.no/api/mapserver/v1/wfs/parker_og_turomraader`
- Lisens: åpne data, uten avtale

## Veikart

Se Gap-kartleggingen (Notion, Nabodata-huben): #4 skoler/barnehager er
bygget separat som drist-udir-mcp; #5 solforhold (horisontprofil fra
hent_hoyde) gjenstår. Jernbane-/flystøy som supplement til `hent_stoysone`
via Geonorge WFS.
