# F1 · Sesión JSF (cliente HTTP + ciclo de vida ViewState)

**Cubre:** R-13 (dueño), R-14 (timeouts, contribuye). Ancla: doc 01 §D-1.
**Módulos:** `src/http/client.ts`, `src/jsf/session.ts`.
**Fixtures:** `test/fixtures/inicio.html`, `test/fixtures/resultado-sin-sesion.html`.

## Propósito
Reproducir la conversación con estado del portal JSF (Mojarra + RichFaces) sobre HTTP puro:
cookie jar persistente (JSESSIONID sticky con sufijo de nodo + `__uzm*`), headers
browser-like, timeouts explícitos, y gestión del `javax.faces.ViewState` (extracción,
renovación por respuesta, detección de expiración → reinicio transparente + replay).

## Entradas / salidas (tipadas)
```ts
interface HttpClient {
  get(url: string): Promise<HttpResponse>;
  postForm(url: string, form: Record<string, string>): Promise<HttpResponse>;
}
interface HttpResponse { status: number; headers: Record<string,string>; data: string; }

interface JsfSession {
  /** Siembra la sesión: GET inicial → cookies + ViewState vigente. */
  init(): Promise<void>;
  /** ViewState vigente parseado de la última respuesta. */
  readonly viewState: string;
  /** POST del form añadiendo el ViewState vigente; renueva viewState desde la respuesta. */
  submit(url: string, form: Record<string,string>): Promise<HttpResponse>;
  /** Re-siembra tras ViewExpired y reejecuta el último paso (máx 2 veces). */
  reset(): Promise<void>;
}
```

## Extracción de ViewState (contrato de parsing)
- Se lee de `input[name="javax.faces.ViewState"]` → atributo `value`.
- En respuestas AJAX RichFaces (`<partial-response>`) se lee de
  `<update id="javax.faces.ViewState"><![CDATA[...]]></update>`.

## Criterios de aceptación (Given/When/Then)
1. **Extrae ViewState de HTML full.**
   Given `inicio.html` como cuerpo de respuesta · When se parsea · Then `viewState ===`
   el value del input (no vacío, formato `\d+:-?\d+` o el que traiga la fixture).
2. **Extrae ViewState de resultado-sin-sesion.**
   Given `resultado-sin-sesion.html` · When se parsea · Then `viewState` no vacío.
3. **Renovación por respuesta.**
   Given una sesión con ViewState A · When `submit()` recibe una respuesta con ViewState B
   · Then el siguiente `submit()` envía B, no A.
4. **Headers browser-like presentes.**
   Given cualquier request · When se inspeccionan headers salientes · Then incluyen
   `User-Agent` (Chrome), `Accept`, `Accept-Language`, y `Referer` coherente con el paso.
5. **Timeout explícito.**
   Given un request · When se configura el cliente · Then `timeout` = `config.timeoutMs`
   (default 30000) y su ausencia es un fallo de test.
6. **Cookies persistentes entre requests.**
   Given `init()` que setea `JSESSIONID` · When se hace un segundo request · Then la cookie
   (incluido el sufijo `.jvmr-scjurispN`) se reenvía intacta.
7. **Detección de ViewExpired → error tipado (R-13).**
   Given una respuesta con `ViewExpiredException` · When se ejecuta `submit()` · Then lanza
   `ViewExpired` (no auto-recupera). **La recuperación** —re-sembrar la secuencia completa
   init + búsqueda + página— es responsabilidad de `JsfPageSource`, que es quien conoce esa
   secuencia; reintentar solo el último `submit` iría contra una sesión sin la búsqueda
   sembrada (shell vacía). `JsfPageSource` reintenta hasta 2 veces re-sembrando todo; agotado,
   propaga. (Corrección de Fase 6: antes el replay estaba en `submit`, con granularidad errónea.)

## Edge cases (doc 00 §3)
- ViewState ausente en el HTML → error tipado `ViewStateNotFound` (no `undefined` silencioso).
- Cookie de sesión ausente tras `init()` → error `SessionSeedFailed`.
- Respuesta 403 del WAF → error tipado `AccessBlocked` con el `Transaction ID` si está.

## Notas de test
La sesión se prueba con fixtures y un transporte inyectado (fake `HttpClient`); **sin red**.
El fake devuelve las fixtures y permite simular ViewExpired y renovación de ViewState.
