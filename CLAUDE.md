# Proyecto: Scraper Challenge — Jurisprudencia PJ Perú (TypeScript, sin navegador)

## Misión
Repositorio público en GitHub con un scraper TypeScript que recorre todo el portal
https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml,
extrae toda la información de cada documento, descarga los PDFs con nombre
descriptivo y sobrevive al rate limiting (429) con backoff + circuit breaker.
Nivel: senior — la resiliencia y la claridad valen más que la velocidad.

## Fuentes de verdad (orden de precedencia)
1. docs/insumos/00_Contexto_Challenge_y_Rubrica.md — challenge destilado + rúbrica R-01..R-24 + anti-criterios.
2. docs/insumos/01_Decisiones_Ancladas_y_Abiertos.md — decisiones YA tomadas (D-1..D-4). NO re-decidir;
   desarrollar. Solo ABIERTO-1..6 admiten decisión, con sus criterios, casi todos en Fase 0.
3. Este archivo.

## Reglas inquebrantables
- PROHIBIDO todo control de navegador (Puppeteer/Playwright/Selenium) en dependencias,
  código o texto. Solo axios/fetch + cheerio. (Anti-criterio 1: descalifica.)
- CORTESÍA CON EL SITIO: es un portal público judicial. Delays con jitter SIEMPRE
  (≥2 s por defecto), concurrencia 1, y las iteraciones de parser se hacen contra
  FIXTURES guardadas en test/fixtures/, no contra el sitio. El sitio solo se toca en
  (a) Fase 0 recon y (b) corridas acotadas deliberadas con --limit.
- SSD: ninguna feature se implementa sin su spec en specs/ con criterios de aceptación
  trazados a checks R-xx. El spec manda; si la implementación lo contradice, se
  actualiza el spec primero (con razón) o la implementación.
- TypeScript strict: true. Cero any sin justificación en comentario. Tipos del dominio
  solo en src/types.ts.
- Toda pieza de resiliencia (backoff, breaker, rate limiter) es pura y testeable sin red.
- Ningún catch silencioso: o se reintenta con política, o va al ledger con motivo.
- Estado persistente: state.json (checkpoint atómico) + failed.json (ledger). Re-ejecutar
  jamás repite trabajo ya hecho.
- Commits por fase/feature con mensaje descriptivo. El repo es el checkpoint del loop.
- README en el idioma del challenge (español), con evidencia real de corrida de muestra.

## Estructura objetivo del repo
scraper-challenge/
├── CLAUDE.md
├── docs/insumos/            # 00, 01, 02 (no se publican: ver nota de publicación)
├── specs/                   # F1..F7 (SSD) — SÍ se publican: muestran método
├── src/                     # según arquitectura de 01 §1 (config, types, http/, jsf/, scraper/, state/, logger, index)
├── test/                    # unit de resiliencia/parser/naming + fixtures/
├── output/                  # data/ y pdfs/ (gitignored)
├── package.json / tsconfig.json / .gitignore / README.md

## Nota de publicación
Al crear el repo público: docs/insumos/ NO se publica (contiene estrategia de
entrevista); specs/ y todo lo demás SÍ. Verificarlo en el gate final.

## Comandos objetivo
npm run scrape             # corrida completa (reanuda si hay estado)
npm run scrape -- --limit 10 --pages 2   # muestra acotada
npm run retry-failed       # consume failed.json
npm test                   # unit sin red
