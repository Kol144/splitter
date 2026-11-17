// The publication build adds this marker. The Node-served app keeps its normal runtime.
export const isStaticHosting = document.querySelector('meta[name="aims-hosting"]')?.content === 'github-pages';
export const hostingMessage = 'La web está publicada. Para importar y separar canciones falta conectar un servidor con Python y Demucs; GitHub Pages solo aloja la interfaz.';

export function showStaticHosting() {
  const text = (selector, value) => { document.querySelector(selector).textContent = value; };
  text('.local-lock', 'WEB PUBLICADA');
  text('.workspace-label small', 'ESPACIO WEB');
  text('#runtime-label', 'Motor pendiente de conectar');
  text('.page-intro', hostingMessage);
  text('.import-title', 'La importación estará disponible al conectar el motor');
  text('.import-subtitle', 'Esta página no sube ni procesa archivos.');
  text('#model-health', 'SIN SERVIDOR');
  text('#model-note', 'Los modelos requieren un servidor de procesamiento.');
  text('#profile-note', 'Procesamiento pendiente de conectar');
  text('.action-hint span:last-child', 'Separación pendiente de servidor');
  text('#cpu-name', 'Servidor sin conectar');
  text('.cpu-chip', 'MOTOR PENDIENTE');
  document.querySelector('.footer-note .footer-lock').nextSibling.textContent = ' Interfaz en GitHub Pages · Motor pendiente ';
  text('#view-library .subpage-heading p', 'La biblioteca estará disponible al conectar el servidor.');
  text('#view-models .subpage-heading p', 'La instalación y ejecución de modelos requiere un servidor con Python y Demucs.');
  text('#view-settings .subpage-heading p', 'Los recursos de procesamiento estarán disponibles al conectar el servidor.');
  text('.catalog-footer', 'Demucs v4 requiere un servidor de procesamiento. GitHub Pages no ejecuta estos modelos.');
  for (const selector of ['#library-grid', '#model-catalog']) {
    const message = document.createElement('div');
    message.className = 'library-empty';
    message.textContent = hostingMessage;
    document.querySelector(selector).replaceChildren(message);
  }
  text('#recent-list .recent-empty', 'Motor pendiente de conectar');
  // Keep navigation/help available, and prevent requests to nonexistent Pages API routes.
  for (const control of document.querySelectorAll('.main-area button, .main-area input, .main-area select, #sidebar-refresh')) {
    if (control.hasAttribute('data-open-view')) continue;
    control.disabled = true;
    control.title = 'Disponible al conectar el servidor de separación';
  }
  for (const value of document.querySelectorAll('#view-settings .setting-value, #view-settings .settings-section-title span')) {
    value.textContent = 'SIN CONECTAR';
  }
}
