/**
 * jsf/forms.ts — Construcción de los formularios JSF de búsqueda y paginación.
 *
 * HIPÓTESIS (ABIERTO-1, deuda D-F0-1): los tokens posicionales se derivaron del recon del
 * `formBuscador` real (inicio.html): la búsqueda envía `forward=buscar`, un tamaño de página
 * (`21` observado), orden (`DESC`), tipo (`Principal`) y un índice de página (`1`). No se pudo
 * confirmar contra una página poblada (el WAF bloquea el acceso). Estas funciones están
 * aisladas a propósito: cuando llegue la fixture real, se ajustan aquí sin tocar el paginator.
 */
import type { CriterioBusqueda } from '../types.js';

/** Tamaño de página observado en los tokens del formulario de búsqueda del recon (`21`). */
export const PAGE_SIZE = 21;

/**
 * Form de la búsqueda inicial (siembra) desde inicio.xhtml. El ViewState lo añade JsfSession.
 * Best-effort sobre la búsqueda especializada; el texto libre usa la búsqueda general.
 */
export function formBusqueda(criterio: CriterioBusqueda, pagina = 1): Record<string, string> {
  const form: Record<string, string> = {
    formBuscador: 'formBuscador',
    // clientId del botón pulsado: es lo que JSF (mojarra.jsfcljs) usa para disparar la acción
    // del componente. Sin él, Mojarra re-renderiza la vista sin ejecutar la búsqueda.
    'formBuscador:j_idt69': 'formBuscador:j_idt69',
    forward: 'buscar',
    // Tokens posicionales observados en el onclick del botón buscar (hipótesis).
    'formBuscador:j_idt71': String(PAGE_SIZE),
    'formBuscador:j_idt72': 'DESC',
    'formBuscador:j_idt73': 'Principal',
    'formBuscador:j_idt74': String(pagina),
  };
  if (criterio.texto) form['formBuscador:txtBusqueda'] = criterio.texto;
  if (criterio.anio) form['formBuscador:buAnio'] = String(criterio.anio);
  if (criterio.nivel) form['formBuscador:buCorte'] = String(criterio.nivel);
  if (criterio.especialidad) form['formBuscador:buEspecialidad'] = String(criterio.especialidad);
  return form;
}

/** Form para pedir la página N sobre la búsqueda ya sembrada (hipótesis: mismo POST, índice N). */
export function formPagina(criterio: CriterioBusqueda, n: number): Record<string, string> {
  return formBusqueda(criterio, n);
}
