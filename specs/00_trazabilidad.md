# Matriz de trazabilidad — R-01..R-24 ↔ specs

Regla del Gate G2: **todo check tiene un spec dueño** (sin huecos) y criterios verificables por
un tercero. Dueño = spec responsable del check; Contribuyen = specs que aportan.

| Check | Descripción (resumen) | Dueño | Contribuyen |
|-------|-----------------------|-------|-------------|
| R-01 | Recorre 100% de páginas | F2 | F1 |
| R-02 | Extrae todos los campos | F3 | F2 |
| R-03 | Doble condición de fin | F2 | — |
| R-04 | PDF con sesión correcta + validado | F4 | F1, F5 |
| R-05 | Nombre descriptivo/seguro/único | F4 | — |
| R-06 | Salida estructurada JSON+CSV tipada | F3 | F6 |
| R-07 | Detecta 429 + Retry-After | F5 | F4 |
| R-08 | Backoff exponencial + jitter + tope | F5 | — |
| R-09 | Agota reintentos → continúa | F5 | F4, F6 |
| R-10 | Ledger failed.json + retry-failed | F6 | F5 |
| R-11 | Circuit breaker global | F5 | — |
| R-12 | Reanudación / idempotencia | F6 | F4 |
| R-13 | Sesión JSF: ViewState/ViewExpired | F1 | — |
| R-14 | Timeouts + política 5xx/red | F5 | F1 |
| R-15 | HTML inesperado no revienta | F3 | — |
| R-16 | Rate limiting propio (delay+jitter+conc.) | F5 | F7 |
| R-17 | Configuración env/CLI | F7 | F5 |
| R-18 | TS estricto + tipos del dominio únicos | F3 | F1 (tsconfig strict, Fase 1) |
| R-19 | Arquitectura por capas | F7 (verifica cohesión) | F1 (estructura), todas |
| R-20 | Comentarios en decisiones no obvias | todas | — (cada spec lo exige) |
| R-21 | README completo | F7 | — |
| R-22 | Tests de lógica pura sin red | F5 | F3, F4, F6 |
| R-23 | Repo/gitignore/scripts/commits | F7 | F1 |
| R-24 | Corrida de muestra documentada | F7 | Fase 5 (evidencia) |

## Huecos / notas
- **Sin huecos:** los 24 checks tienen dueño.
- **Transversales** (R-19/R-20): R-20 lo exige cada spec en su sección de notas; R-19 se
  garantiza por la estructura de Fase 1 (regla de dependencias: `scraper/*` usa `http`+`jsf`,
  `resilience` no conoce JSF ni dominio) y lo audita el juez "Ingeniero senior TS" en Fase 6.
- **R-24** depende de la corrida real (Fase 5), hoy bloqueada por el 403 desde esta red
  (deuda D-F0-2). Se cubrirá con una corrida en seco documentada + corrida real diferida a una
  red con acceso; se declara como limitación conocida en el README (circuit breaker del loop).

## Estado de specs (Gate G2)
Las specs F2/F3 dependen de la fixture poblada (deuda D-F0-1) para congelar la mecánica exacta
de paginación (ABIERTO-1) y el mapeo de campos (ABIERTO-5). Los criterios de aceptación están
escritos de forma verificable; los tests que usen fixture sintética lo declaran explícitamente y
se re-validan contra la fixture real cuando esté disponible.
