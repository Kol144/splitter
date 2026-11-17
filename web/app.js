import { trackState } from './mixer-state.js';
import { isStaticHosting, hostingMessage, showStaticHosting } from './hosting.js';

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const state = {
  project: null, projects: [], models: [], modelOperation: null, mode: 'quick', profile: 'balanced',
  threads: Number(localStorage.getItem('aims-threads')) === 6 ? 6 : 4,
  selectedSources: new Set(), audioContext: null, trackPlayers: new Map(), activeJob: null,
  jobStartedAt: 0, timer: null, transportTimer: null, solo: new Set(), previewStem: null, masterMuted: false, masterVolume: .8, ffmpeg: false,
  sourceAudio: null, trackDuration: 0, currentTime: 0, currentView: 'studio', pendingModel: null,
  stemVariant: 'refined', audioGeneration: 0, waveformAbort: null, playbackRequest: 0
};

const api = async (url, options = {}) => {
  if (isStaticHosting) throw new Error(hostingMessage);
  const response = await fetch(url, { cache: 'no-store', ...options });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.blob();
  if (!response.ok) throw new Error(body?.error || `Error ${response.status}`);
  return body;
};

function toast(title, message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = `<strong class="toast-title"></strong><p></p>`;
  $('.toast-title', node).textContent = title;
  $('p', node).textContent = message;
  $('#toast-region').append(node);
  setTimeout(() => node.remove(), 5500);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function formatTime(seconds = 0) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const secs = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function outputDetails(project) {
  const format = project?.metadata?.inference?.outputFormat || 'pcm16';
  const bitDepth = format === 'float32' ? 32 : format === 'pcm24' ? 24 : 16;
  return {
    format,
    bitDepth,
    label: format === 'float32' ? '32-bit float' : `${bitDepth} bit`
  };
}

function projectModelLabel(project) {
  const model = project?.metadata?.lastModel?.toUpperCase() || 'HTDEMUCS';
  const inference = project?.metadata?.inference;
  if (!inference) return `MODEL · ${model}`;
  return `MODEL · ${model} · ${inference.label?.toUpperCase() || inference.profile?.toUpperCase() || 'CUSTOM'} · ${outputDetails(project).label.toUpperCase()}`;
}

function syncExportToProject(project) {
  const bits = String(outputDetails(project).bitDepth);
  const select = $('#export-bits');
  if (select && [...select.options].some(option => option.value === bits)) {
    select.value = bits;
    updateExportControls();
  }
}

function exportQuery() {
  return new URLSearchParams({
    format: $('#export-format').value,
    rate: $('#export-rate').value,
    bits: $('#export-bits').value,
    channels: $('#export-channels').value,
    variant: state.stemVariant,
    normalize: $('#export-normalize').checked ? '1' : '0'
  }).toString();
}

function updateExportControls() {
  const format = $('#export-format').value;
  const lossy = ['mp3', 'aac', 'ogg'].includes(format);
  $('#export-bits').disabled = lossy;
  if (format === 'flac' && $('#export-bits').value === '32') $('#export-bits').value = '24';
  for (const input of $$('#export-options select, #export-options input')) {
    const key = `aims-export-${input.id.replace('export-', '')}`;
    localStorage.setItem(key, input.type === 'checkbox' ? String(input.checked) : input.value);
  }
  updateExportLinks();
}

function updateExportLinks() {
  if (!state.project) return;
  const params = exportQuery();
  $('#download-all').href = `/api/projects/${state.project.id}/export.zip?${params}`;
  $$('.track-download').forEach(anchor => {
    const name = anchor.closest('.track-row')?.dataset.stem;
    if (name) anchor.href = `/api/projects/${state.project.id}/stems/${encodeURIComponent(name)}?${params}`;
  });
}

function exportRequiresFfmpeg() {
  return !state.ffmpeg && !(
    $('#export-format').value === 'wav' && $('#export-rate').value === '44100' &&
    $('#export-bits').value === String(outputDetails(state.project).bitDepth) && $('#export-channels').value === '2' && !$('#export-normalize').checked
  );
}

function prettyCpu(model = 'CPU') {
  return model.replace(/\(R\)|\(TM\)|CPU @.*$/gi, '').replace(/\s+/g, ' ').trim() || 'CPU local';
}

async function refreshSystem() {
  try {
    const info = await api('/api/health');
    state.ffmpeg = Boolean(info.ffmpeg);
    const hardware = info.hardware;
    const free = hardware.availableMemoryBytes;
    const total = hardware.totalMemoryBytes;
    const gpuSummary = hardware.gpu?.adapters?.length
      ? hardware.gpu.adapters.map(item => `${item.name}${item.driver ? ` · driver ${item.driver}` : ''}`).join('; ')
      : hardware.gpu?.name ? `${hardware.gpu.name}${hardware.gpu.driver ? ` · driver ${hardware.gpu.driver}` : ''}`
      : hardware.gpu?.status || 'No se pudo verificar el adaptador gráfico.';
    $('#memory-value').textContent = `${(free / 1024 ** 3).toFixed(1)} GB`;
    $('#memory-bar-fill').style.width = `${Math.max(2, Math.min(100, (free / total) * 100))}%`;
    $('#cpu-name').textContent = prettyCpu(hardware.cpu);
    $('#thread-count').textContent = `${state.threads}/${hardware.logicalCores} hilos`;
    $('#runtime-label').textContent = info.python.available ? 'Motor Demucs listo' : 'Python/Demucs pendiente';
    $('.runtime-status .status-dot').classList.toggle('green', info.python.available);
    $('#system-details').textContent = [
      `Sistema: ${hardware.os} · ${hardware.architecture}`,
      `CPU: ${hardware.cpu} · ${hardware.physicalCores ?? '—'} núcleos físicos · ${hardware.logicalCores} hilos lógicos${hardware.maxClockMHz ? ` · ${hardware.maxClockMHz} MHz reportados` : ''}`,
      `RAM: ${(total / 1024 ** 3).toFixed(1)} GB total · ${(free / 1024 ** 3).toFixed(1)} GB disponible`,
      `GPU: ${gpuSummary}`,
      `Python + Demucs: ${info.python.available ? `disponible (${info.python.version})` : info.python.message}`,
      `FFmpeg: ${info.ffmpeg ? 'disponible' : 'no detectado'} · ffprobe: ${info.ffprobe ? 'disponible' : 'no detectado'}`,
      'Aceleración CUDA/XPU: desactivada; inferencia CPU predeterminada.'
    ].join('\n');
    $('#threads-select').value = String(state.threads);
  } catch (error) {
    $('#runtime-label').textContent = 'Backend no disponible';
    toast('No se pudo consultar el sistema', error.message, 'error');
  }
}

async function refreshModels() {
  try {
    const data = await api('/api/models');
    state.models = data.models || [];
    state.modelOperation = data.operation;
    if (!localStorage.getItem('aims-model') && state.models.some(model => model.id === 'htdemucs_ft' && model.installed)) {
      $('#model-select').value = 'htdemucs_ft';
    }
    renderModelHealth();
    renderModelCatalog();
    setProfile(state.profile);
    if (state.modelOperation && !['completed', 'failed', 'cancelled'].includes(state.modelOperation.status)) pollModelOperation();
    else if (state.modelOperation?.status === 'completed' && state.lastModelCompletion !== state.modelOperation.id) {
      state.lastModelCompletion = state.modelOperation.id;
      toast('Modelo instalado', `${modelName(state.modelOperation.model)} está listo en este equipo.`, 'success');
    }
  } catch (error) {
    console.warn('Model inventory unavailable:', error);
  }
}

function modelName(id) { return state.models.find(model => model.id === id)?.name || ({ htdemucs: 'HTDemucs', htdemucs_ft: 'HTDemucs Fine-Tuned', mdx_extra: 'MDX-Extra', mdx_extra_q: 'MDX-Extra-Q', htdemucs_6s: 'HTDemucs 6S' })[id] || id; }
function selectedModel() { return state.models.find(model => model.id === $('#model-select').value) || { id: $('#model-select').value, sources: ['vocals', 'drums', 'bass', 'other'], installed: false }; }

function renderModelHealth() {
  const model = selectedModel();
  const badge = $('#model-health');
  badge.textContent = model.installed ? 'INSTALLED' : model.dependencyMessage ? 'DEPENDENCY MISSING' : 'NOT INSTALLED';
  badge.classList.toggle('missing', !model.installed);
  const requiredMemory = model.minFreeMemoryBytes ? ` · requiere ${(model.minFreeMemoryBytes / 1024 ** 3).toFixed(1)} GB de RAM libre` : '';
  $('#model-note').textContent = model.installed
    ? `${model.quality || 'Modelo local'} · CPU ${model.cpuCost || '—'}${requiredMemory} · ${formatBytes(model.cacheBytes)} en caché · sin conexión disponible.`
    : model.dependencyMessage || 'Motor real · CPU local · primero instala los pesos desde AI Models.';
  const installBusy = state.modelOperation && !['completed', 'failed', 'cancelled', 'idle'].includes(state.modelOperation.status);
  $('#separate-button').disabled = !state.project || !state.project.hasAudio || !model.installed || Boolean(state.activeJob) || Boolean(installBusy);
  $('#refine-stems').disabled = !state.project?.stems?.length || Boolean(state.activeJob) || Boolean(installBusy);
  $('#installed-count').textContent = String(state.models.filter(item => item.installed).length);
  if (state.mode === 'advanced') renderSourceOptions();
}

function renderModelCatalog() {
  const container = $('#model-catalog');
  if (!container) return;
  if (!state.models.length) {
    container.innerHTML = '<div class="library-empty">No se pudo cargar el catálogo de modelos.</div>';
    return;
  }
  const icons = { htdemucs: '✳', htdemucs_ft: '✦', mdx_extra: '▧', mdx_extra_q: '▧', htdemucs_6s: '◈' };
  container.innerHTML = state.models.map(model => `
    <article class="model-card ${model.experimental ? 'experimental' : ''}">
      <div class="model-card-icon">${icons[model.id] || '✳'}</div>
      <div class="model-card-copy"><div class="model-card-title"><h3>${escapeHtml(model.name)}</h3>${model.recommendedForQuality ? '<span class="quality-tag">MEJOR CALIDAD</span>' : ''}${model.experimental ? '<span class="experimental-tag">EXPERIMENTAL</span>' : ''}</div><p>${escapeHtml(model.description)}</p>${model.dependencyMessage ? `<p class="dependency-note">${escapeHtml(model.dependencyMessage)}</p>` : ''}<div class="model-card-meta">${escapeHtml(model.group)} · Licencia ${escapeHtml(model.license)} · ${escapeHtml(model.quality || '—')} · CPU ${escapeHtml(model.cpuCost || '—')}${model.minFreeMemoryBytes ? ` · RAM libre ≥ ${(model.minFreeMemoryBytes / 1024 ** 3).toFixed(1)} GB` : ''}${model.installed ? ` · ${formatBytes(model.cacheBytes)} instalados` : ''}</div></div>
      <div><div class="model-sources">${model.sources.map(source => `<span class="model-source-pill">${escapeHtml(source)}</span>`).join('')}</div><div class="model-card-meta">${model.installed ? `${model.sources.length} grupos de fuentes` : `Descarga: ${escapeHtml(model.size)}`}</div></div>
      <div class="model-card-actions">${model.installed ? `<span class="installed-tag">✓ INSTALLED</span><button class="outline-button model-remove" data-model="${model.id}">Remove</button>` : model.dependencyMessage ? '<span class="dependency-tag">DEPENDENCY REQUIRED</span>' : `<button class="outline-button model-install" data-model="${model.id}" ${state.modelOperation && !['completed', 'failed', 'cancelled', 'idle'].includes(state.modelOperation.status) ? 'disabled' : ''}>↓ Install</button>`}</div>
    </article>`).join('');
  $$('.model-install', container).forEach(button => button.addEventListener('click', () => prepareModelInstall(button.dataset.model)));
  $$('.model-remove', container).forEach(button => button.addEventListener('click', () => removeModel(button.dataset.model)));
}

async function removeModel(id) {
  const model = state.models.find(item => item.id === id);
  if (!model || !confirm(`¿Quitar los pesos locales de ${model.name}? Los proyectos y stems existentes se conservarán.`)) return;
  try {
    const result = await api(`/api/models/${id}`, { method: 'DELETE' });
    await refreshModels();
    toast('Pesos eliminados', `Se liberaron ${formatBytes(result.freedBytes)}. Los proyectos siguen guardados.`, 'success');
  } catch (error) { toast('No se pudo quitar el modelo', error.message, 'error'); }
}

function renderSourceOptions() {
  const model = selectedModel();
  const block = $('#source-options-block');
  block.classList.remove('hidden');
  const items = model.sources || [];
  if (!model.installed) {
    state.selectedSources = new Set();
    $('#source-options').innerHTML = `<span class="unavailable-source">${escapeHtml(model.name || 'Este modelo')} no está instalado. No hay fuentes adicionales disponibles.</span>`;
    $('#source-note').textContent = 'Instala un modelo antes de seleccionar las fuentes que conservarás.';
    return;
  }
  if (!state.selectedSources.size || ![...state.selectedSources].every(item => items.includes(item))) state.selectedSources = new Set(items);
  $('#source-options').innerHTML = items.map(source => `<label class="source-check"><input type="checkbox" value="${source}" ${state.selectedSources.has(source) ? 'checked' : ''} />${source[0].toUpperCase()}${source.slice(1)}</label>`).join('');
  $$('input', $('#source-options')).forEach(input => input.addEventListener('change', () => {
    if (input.checked) state.selectedSources.add(input.value); else state.selectedSources.delete(input.value);
  }));
  $('#source-note').textContent = model.experimental
    ? 'El modelo calcula todas estas fuentes; guitarra y piano son experimentales y pueden contener filtraciones. La selección solo decide qué stems se conservan.'
    : 'El modelo calcula todas sus fuentes compatibles; aquí eliges cuáles se conservan en el proyecto. Reducir la selección no reduce el cálculo de IA.';
}

async function loadProjects() {
  try {
    state.projects = await api('/api/projects');
    renderRecent();
    renderLibrary();
    $('#library-count').textContent = `${state.projects.length} PROJECT${state.projects.length === 1 ? '' : 'S'}`;
  } catch (error) { console.warn('Library unavailable:', error); }
}

function renderRecent() {
  const container = $('#recent-list');
  if (!state.projects.length) { container.innerHTML = '<div class="recent-empty">Tus proyectos aparecerán aquí.</div>'; return; }
  container.innerHTML = state.projects.slice(0, 6).map(project => `<button class="recent-project" data-project="${project.id}"><span>◌</span><strong>${escapeHtml(project.name)}</strong></button>`).join('');
  $$('.recent-project', container).forEach(button => button.addEventListener('click', () => openProject(button.dataset.project)));
}

function renderLibrary() {
  const container = $('#library-grid');
  if (!state.projects.length) {
    container.innerHTML = '<div class="library-empty"><div><div class="empty-mark">✳</div>Todavía no hay proyectos guardados.<br /><span style="color:#667267;font-size:9px">Importa una canción para crear el primero.</span></div></div>';
    return;
  }
  container.innerHTML = state.projects.map(project => `<article class="library-card" data-project="${project.id}"><div class="library-card-art">✳</div><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.status.replaceAll('-', ' ').toUpperCase())}</p><div class="library-card-bottom"><span>${project.duration ? formatTime(project.duration) : 'DURACIÓN PENDIENTE'}</span><span>${project.stems.length ? `${project.stems.length} STEMS` : project.mediaKind.toUpperCase()}</span></div></article>`).join('');
  $$('.library-card', container).forEach(card => card.addEventListener('click', () => { selectView('studio'); openProject(card.dataset.project); }));
}

function selectView(view) {
  state.currentView = view;
  $$('.view').forEach(section => section.classList.toggle('active', section.id === `view-${view}`));
  $$('.nav-item[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $('.main-area').scrollTop = 0;
}

function applyProject(project) {
  if (state.sourceAudio) { state.sourceAudio.pause(); state.sourceAudio.removeAttribute('src'); state.sourceAudio.load(); state.sourceAudio = null; }
  state.project = project;
  state.stemVariant = 'refined';
  if (project) {
    localStorage.setItem('aims-current-project', project.id);
    $('#heading-context').textContent = 'SOURCE LOADED';
    $('#studio-title').innerHTML = `Separate the music.<br /><em>Keep every note.</em>`;
    $('#import-panel').classList.add('hidden');
    $('#source-card').classList.remove('hidden');
    $('#source-name').textContent = project.originalName || project.name;
    const meta = [project.duration ? formatTime(project.duration) : null, project.sampleRate ? `${(project.sampleRate / 1000).toFixed(1)} kHz` : null, project.channels ? `${project.channels === 1 ? 'Mono' : 'Stereo'}` : null, project.metadata?.bytes ? formatBytes(project.metadata.bytes) : null].filter(Boolean);
    $('#source-meta').textContent = meta.join(' · ') || project.mediaKind.toUpperCase();
    if (project.mediaKind === 'video' && !project.hasAudio && project.metadata?.needsExtraction) showAudioStreamSelector(project);
    else removeAudioStreamSelector();
    if (project.stems?.length) {
      $('#results-section').classList.remove('hidden');
      $('#mix-model').textContent = projectModelLabel(project);
      loadStemPlayers(project);
    } else {
      stopTransport();
      $('#results-section').classList.add('hidden');
    }
    $('#setup-grid').classList.toggle('hidden', !project.hasAudio || Boolean(project.stems?.length));
    $('#action-row').classList.toggle('hidden', !project.hasAudio || Boolean(project.stems?.length));
    $('#separate-button').disabled = !project.hasAudio || !selectedModel().installed;
    $('#separate-button').innerHTML = '<span class="button-spark">✳</span> SEPARAR <span class="button-arrow">→</span>';
    $('#results-count').textContent = `${project.stems?.length || 0} tracks`;
    if (project.stems?.length) syncExportToProject(project);
    updateExportLinks();
    $('#transport-title').textContent = project.name;
    $('#transport-subtitle').textContent = `${project.stems?.length || 0} local stems`;
    renderModelHealth();
    if (project.stems?.length) {
      $('#transport').classList.remove('hidden');
      $('#results-section').classList.remove('hidden');
    } else $('#transport').classList.add('hidden');
    return;
  }
  localStorage.removeItem('aims-current-project');
  $('#heading-context').textContent = 'NEW SESSION';
  $('#source-card').classList.add('hidden');
  $('#import-panel').classList.remove('hidden');
  $('#setup-grid').classList.remove('hidden');
  $('#action-row').classList.remove('hidden');
  $('#results-section').classList.add('hidden');
  $('#job-panel').classList.add('hidden');
  $('#transport').classList.add('hidden');
  removeAudioStreamSelector();
  stopTransport();
  renderModelHealth();
}

function showAudioStreamSelector(project) {
  removeAudioStreamSelector();
  const streams = project.metadata?.audioStreams || [];
  const card = $('#source-card');
  const control = document.createElement('div');
  control.className = 'video-extract-row';
  if (!project.metadata?.ffmpegAvailable) {
    control.innerHTML = '<span class="video-warning">FFmpeg no detectado. Instálalo para extraer audio de vídeo.</span>';
  } else if (!streams.length) {
    control.innerHTML = '<span class="video-warning">No se encontró una pista de audio. Revisa FFmpeg o el formato del vídeo.</span>';
  } else {
    const options = streams.map(stream => {
      const rate = stream.sampleRate ? `${(stream.sampleRate / 1000).toFixed(1)} kHz` : '— kHz';
      return `<option value="${stream.audioIndex}">${escapeHtml(stream.label)} · ${escapeHtml(stream.codec || 'audio')} · ${rate} · ${stream.channels || '—'} ch${stream.language ? ` · ${escapeHtml(stream.language)}` : ''}</option>`;
    }).join('');
    control.innerHTML = `<select class="audio-stream-select" aria-label="Pista de audio">${options}</select><button class="outline-button" id="extract-audio">Extraer audio</button>`;
    $('#source-meta').textContent = `${streams.length} pista${streams.length === 1 ? '' : 's'} de audio · vídeo local`;
  }
  card.append(control);
  const extract = $('#extract-audio');
  if (extract) extract.addEventListener('click', async () => {
    extract.disabled = true; extract.textContent = 'Extrayendo…';
    try {
      const result = await api(`/api/projects/${project.id}/extract`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audioIndex: Number($('.audio-stream-select', control).value) }) });
      extract.textContent = 'Extrayendo…';
      await pollAudioExtraction(project.id, result.id, extract);
    } catch (error) { toast('No se pudo extraer el audio', error.message, 'error'); extract.disabled = false; extract.textContent = 'Reintentar'; }
  });
}

async function pollAudioExtraction(projectId, operationId, button) {
  while (true) {
    const operation = await api(`/api/projects/${projectId}/extract`);
    if (operation.id !== operationId) throw new Error('La operación de extracción cambió.');
    if (operation.status === 'completed') {
      const project = await api(`/api/projects/${projectId}`);
      applyProject(project); await loadProjects();
      toast('Audio extraído', 'El vídeo permanece guardado localmente.', 'success');
      return;
    }
    if (operation.status === 'failed') throw new Error(operation.error || operation.message || 'FFmpeg no pudo extraer el audio.');
    if (operation.status === 'cancelled') throw new Error('Extracción cancelada.');
    button.disabled = true;
    button.textContent = 'Extrayendo…';
    await new Promise(resolve => setTimeout(resolve, 800));
  }
}

function removeAudioStreamSelector() { $('.video-extract-row')?.remove(); }

async function openProject(id) {
  try {
    const project = await api(`/api/projects/${id}`);
    applyProject(project);
    selectView('studio');
  } catch (error) { toast('No se pudo abrir el proyecto', error.message, 'error'); }
}

function browserMetadata(file) {
  return new Promise(resolve => {
    const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|mkv|avi|webm)$/i.test(file.name);
    const element = document.createElement(isVideo ? 'video' : 'audio');
    const url = URL.createObjectURL(file);
    element.preload = 'metadata';
    element.onloadedmetadata = () => {
      const data = { duration: Number.isFinite(element.duration) ? element.duration : null, fileType: file.type || null };
      URL.revokeObjectURL(url); resolve(data);
    };
    element.onerror = () => { URL.revokeObjectURL(url); resolve({}); };
    element.src = url;
  });
}

async function importFile(file) {
  if (!file) return;
  if (isStaticHosting) return toast('Motor pendiente de conectar', hostingMessage);
  $('#browse-cta').disabled = true;
  $('#browse-cta').textContent = 'Importando…';
  toast('Importando archivo', 'Se guarda en data/projects dentro de esta carpeta local.');
  try {
    const metadata = await browserMetadata(file);
    const headers = { 'Content-Type': file.type || 'application/octet-stream', 'X-Media-Metadata': btoa(unescape(encodeURIComponent(JSON.stringify({ ...metadata, size: file.size })))) };
    const project = await api(`/api/import?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers, body: file });
    applyProject(project);
    await loadProjects();
    selectView('studio');
    toast('Archivo importado', project.mediaKind === 'video' ? 'Elige la pista de audio y extráela con FFmpeg.' : 'Puedes preparar una separación cuando instales un modelo.', 'success');
  } catch (error) { toast('No se pudo importar', error.message, 'error'); }
  finally { $('#browse-cta').disabled = false; $('#browse-cta').innerHTML = '<span>＋</span> Importar archivo'; $('#file-input').value = ''; }
}

async function prepareModelInstall(id) {
  const model = state.models.find(item => item.id === id);
  if (!model) return;
  const dialog = $('#confirm-dialog');
  $('#dialog-title').textContent = `Install ${model.name}?`;
  $('#dialog-body').textContent = `Se descargarán los pesos oficiales de Demucs al caché local de PyTorch. La app no sube tus archivos.`;
  $('#dialog-size').textContent = 'Comprobando el tamaño desde la fuente oficial…';
  const confirm = $('#dialog-confirm');
  confirm.disabled = true;
  confirm.textContent = 'DESCARGAR';
  dialog.showModal();
  try {
    const size = await api(`/api/models/${id}/size`, { method: 'POST' });
    $('#dialog-size').textContent = `Descarga total: ${formatBytes(size.bytes)} · ${size.files.length} archivo(s) · ${size.source}`;
    confirm.disabled = false;
  } catch (error) {
    $('#dialog-size').textContent = `Tamaño no disponible: ${error.message}. La descarga necesita conexión a Internet.`;
    confirm.disabled = false;
  }
  confirm.onclick = async event => {
    event.preventDefault();
    dialog.close();
    try {
      await api(`/api/models/${id}/install`, { method: 'POST' });
      state.modelOperation = { model: id, status: 'downloading', detail: 'Descargando pesos oficiales…', log: [] };
      renderModelCatalog();
      pollModelOperation();
    } catch (error) { toast('No se pudo instalar el modelo', error.message, 'error'); }
  };
}

async function pollModelOperation() {
  if (!state.modelOperation || state.modelPollRunning) return;
  state.modelPollRunning = true;
  const panel = $('#model-operation');
  panel.classList.remove('hidden');
  try {
    let loops = 0;
    while (loops++ < 1800) {
      const data = await api('/api/models');
      state.modelOperation = data.operation;
      if (!state.modelOperation || ['completed', 'failed', 'cancelled', 'idle'].includes(state.modelOperation.status)) break;
      $('#model-operation-title').textContent = `${modelName(state.modelOperation.model)} · ${state.modelOperation.status.toUpperCase()}`;
      $('#model-operation-detail').textContent = state.modelOperation.detail || state.modelOperation.log?.at(-1) || 'Descargando pesos oficiales…';
      renderModelCatalog();
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    panel.classList.add('hidden');
    if (state.modelOperation?.status === 'failed') toast('Error al instalar', state.modelOperation.error || 'La descarga o comprobación falló.', 'error');
    if (state.modelOperation?.status === 'cancelled') toast('Descarga cancelada', 'No se inició ninguna separación.');
    await refreshModels();
  } catch (error) { panel.classList.add('hidden'); toast('No se pudo consultar el modelo', error.message, 'error'); }
  finally { state.modelPollRunning = false; }
}

async function startSeparation() {
  if (!state.project) return;
  if (!state.project.hasAudio && state.project.mediaKind === 'video') return showAudioStreamSelector(state.project);
  const model = selectedModel();
  if (!model.installed) return toast('Modelo no instalado', 'Instala los pesos desde AI Models antes de separar.', 'error');
  if (state.profile === 'maximum') {
    const detail = model.ensemble
      ? `${model.name} ya combina varios modelos. MAX QUALITY usará solapamiento 0.5 y WAV 32-bit float sin multiplicar otra vez el coste del ensemble.`
      : 'MAX QUALITY usará dos predicciones con desplazamientos aleatorios, solapamiento 0.5 y WAV 32-bit float.';
    if (!confirm(`${detail}\n\nPuede tardar bastante más y necesitará más espacio de disco. ¿Continuar?`)) return;
  }
  $('#separate-button').disabled = true;
  try {
    const job = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: state.project.id, model: model.id, profile: state.profile, threads: state.threads, silenceRefinement: $('#silence-refinement').value, sources: state.mode === 'quick' ? model.sources : [...state.selectedSources] }) });
    state.activeJob = job;
    state.jobStartedAt = Date.now();
    $('#job-panel').classList.remove('hidden');
    $('#job-title').textContent = 'Preparando modelo…';
    $('#job-detail').textContent = `${model.name} · CPU · ${state.threads} hilos · 1 trabajo`;
    $('#job-progress-fill').style.width = '32%';
    state.timer = setInterval(() => { $('#job-elapsed').textContent = formatTime((Date.now() - state.jobStartedAt) / 1000); }, 500);
    pollJob(job.id);
  } catch (error) { toast('No se pudo iniciar la separación', error.message, 'error'); }
  finally { renderModelHealth(); }
}

async function startRefinement() {
  if (!state.project?.stems?.length || state.activeJob) return;
  $('#refine-stems').disabled = true;
  try {
    const job = await api(`/api/projects/${state.project.id}/refine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: $('#cleanup-mode').value }) });
    state.activeJob = job;
    state.jobStartedAt = Date.now();
    $('#job-panel').classList.remove('hidden');
    $('#job-title').textContent = 'Revisando los silencios…';
    $('#job-detail').textContent = 'Analizando segmentos débiles. Los originales se conservan.';
    state.timer = setInterval(() => { $('#job-elapsed').textContent = formatTime((Date.now() - state.jobStartedAt) / 1000); }, 500);
    pollJob(job.id);
  } catch (error) { toast('No se pudo iniciar la revisión', error.message, 'error'); }
  finally { renderModelHealth(); }
}

async function pollJob(id) {
  try {
    while (true) {
      const job = await api(`/api/jobs/${id}`);
      state.activeJob = job;
      $('#job-title').textContent = ({ preparing: 'Preparando modelo…', 'loading-model': 'Cargando el modelo…', separating: 'Separando fuentes en CPU…', refining: 'Revisando los silencios…', cancelling: 'Cerrando el proceso de IA…' })[job.status] || job.status;
      $('#job-detail').textContent = job.message || job.logs?.at(-1) || 'El trabajo sigue activo. Los archivos permanecen locales.';
      $('#job-progress-fill').style.width = job.status === 'separating' ? '62%' : job.status === 'completed' ? '100%' : '35%';
      $('#cancel-job').disabled = job.status === 'cancelling';
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        clearInterval(state.timer); state.timer = null;
        if (job.status === 'completed') {
          const project = await api(`/api/projects/${job.projectId}`);
          if (state.project?.id === job.projectId) applyProject(project);
          await loadProjects();
          toast(job.profile === 'refinement' ? 'Revisión terminada' : 'Separación terminada', job.message, 'success');
        } else if (job.status === 'failed') toast('La separación falló', job.message, 'error');
        else toast('Trabajo cancelado', job.message || 'El trabajo se canceló.');
        $('#job-panel').classList.add('hidden');
        state.activeJob = null;
        renderModelHealth();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) { toast('Se perdió la conexión con el trabajo', error.message, 'error'); }
}

async function cancelJob() {
  if (!state.activeJob?.id) return;
  try {
    $('#cancel-job').disabled = true;
    $('#job-detail').textContent = 'Solicitando el cierre seguro del proceso de IA…';
    await api(`/api/jobs/${state.activeJob.id}/cancel`, { method: 'POST' });
  }
  catch (error) { $('#cancel-job').disabled = false; toast('No se pudo cancelar', error.message, 'error'); }
}

function getAudioContext() {
  if (!state.audioContext) state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  return state.audioContext;
}

const trackPresentation = {
  vocals: { color: '#c8f36a', icon: '◉', title: 'VOCALS' },
  drums: { color: '#e7ab67', icon: '⦿', title: 'DRUMS' },
  bass: { color: '#77b9eb', icon: '≋', title: 'BASS' },
  other: { color: '#ca9be9', icon: '◈', title: 'OTHER' },
  guitar: { color: '#e98d8d', icon: '⌁', title: 'GUITAR' },
  piano: { color: '#74d6c3', icon: '▤', title: 'PIANO' }
};

function drawWaveform(canvas, buffer, color) {
  const width = Math.max(300, Math.floor(canvas.getBoundingClientRect().width * devicePixelRatio));
  const height = Math.max(50, Math.floor(canvas.getBoundingClientRect().height * devicePixelRatio));
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  const channelA = buffer.getChannelData(0);
  const channelB = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : channelA;
  const bins = Math.min(width, 2200);
  const block = Math.max(1, Math.floor(channelA.length / bins));
  const middle = height / 2;
  ctx.fillStyle = color;
  for (let bin = 0; bin < bins; bin++) {
    let minimum = 1, maximum = -1;
    const start = bin * block;
    const end = Math.min(channelA.length, start + block);
    for (let sample = start; sample < end; sample += Math.max(1, Math.floor(block / 16))) {
      minimum = Math.min(minimum, channelA[sample], channelB[sample]);
      maximum = Math.max(maximum, channelA[sample], channelB[sample]);
    }
    const amp = Math.max(1.2, (maximum - minimum) * height * .42);
    const x = Math.floor((bin / bins) * width);
    ctx.globalAlpha = .82;
    ctx.fillRect(x, middle - amp / 2, Math.max(1, Math.ceil(width / bins * .56)), amp);
  }
  ctx.globalAlpha = .13;
  ctx.fillStyle = '#e8eee3';
  ctx.fillRect(0, Math.floor(middle), width, 1);
  ctx.globalAlpha = 1;
}

async function buildTrackRows(project) {
  const container = $('#track-list');
  const tracks = project.stems || [];
  const output = outputDetails(project);
  const trackSpec = `WAV · 44.1 kHz · ${output.label.toUpperCase()} · STEREO`;
  const generation = state.audioGeneration;
  container.innerHTML = tracks.map((track, index) => {
    const meta = trackPresentation[track.name] || { color: '#c8f36a', icon: '◈', title: track.name.toUpperCase() };
    return `<div class="track-row" data-stem="${escapeHtml(track.name)}" style="--track-color:${meta.color};--entry-delay:${index * 45}ms"><div class="track-label"><span class="track-color"></span><button class="track-play" title="Escuchar solo ${escapeHtml(track.name)}" aria-label="Escuchar solo ${escapeHtml(track.name)}" aria-pressed="false">▶</button><span class="track-icon">${meta.icon}</span><div class="track-name"><strong>${escapeHtml(meta.title)}</strong><small>${trackSpec}</small><span class="track-status">LISTA</span></div></div><div class="wave-wrap" title="Forma de onda de ${escapeHtml(track.name)}"><canvas class="wave-canvas"></canvas><div class="wave-loading">LEYENDO AUDIO REAL…</div><span class="wave-playhead"></span></div><div class="track-controls"><button class="track-solo" aria-label="Solo ${escapeHtml(track.name)}" aria-pressed="false" title="Solo: puedes activar varias pistas">S</button><button class="track-mute" aria-label="Silenciar ${escapeHtml(track.name)}" aria-pressed="false" title="Silenciar pista">M</button><input class="track-volume" type="range" min="0" max="1" step="0.01" value="1" aria-label="Volumen ${escapeHtml(track.name)}" /><a class="track-download track-download-link" href="/api/projects/${project.id}/stems/${encodeURIComponent(track.name)}" aria-label="Descargar ${escapeHtml(track.name)}" title="Descargar stem">↓</a></div></div>`;
  }).join('');
  state.trackDuration = project.duration || 0;
  // Register every control immediately, then decode waveforms one at a time.
  // Never retain complete decoded songs once their canvas has been drawn.
  for (const track of tracks) createTrackAudio(project, track);
  applyTrackGains();
  $('#results-count').textContent = `${tracks.length} tracks`;
  $('#transport').classList.toggle('hidden', tracks.length === 0);
  $('#total-time').textContent = formatTime(state.trackDuration);
  updateExportLinks();
  for (const track of tracks) {
    if (generation !== state.audioGeneration) return;
    await loadTrackWaveform(track.name, generation);
  }
}

function createTrackAudio(project, track) {
  const row = $(`.track-row[data-stem="${CSS.escape(track.name)}"]`);
  if (!row) return;
  const url = `/api/projects/${project.id}/stems/${encodeURIComponent(track.name)}?play=1&variant=${state.stemVariant}`;
  const audio = new Audio(url);
  audio.preload = 'none';
  audio.crossOrigin = 'same-origin';
  const ctx = getAudioContext();
  const source = ctx.createMediaElementSource(audio);
  const gain = ctx.createGain();
  gain.gain.value = 1;
  source.connect(gain).connect(ctx.destination);
  state.trackPlayers.set(track.name, { audio, source, gain, muted: false, volume: 1, row, url });
  audio.addEventListener('loadedmetadata', () => {
    state.trackDuration = Math.max(state.trackDuration, audio.duration || 0);
    $('#total-time').textContent = formatTime(state.trackDuration);
  });
  audio.addEventListener('ended', updateTransport);
  $('.track-play', row).addEventListener('click', () => previewTrack(track.name));
  $('.track-solo', row).addEventListener('click', () => {
    const wasPlaying = isPlaying();
    if (state.solo.has(track.name)) state.solo.delete(track.name); else state.solo.add(track.name);
    state.previewStem = null;
    applyTrackGains();
    if (wasPlaying) playMix();
  });
  $('.track-mute', row).addEventListener('click', () => {
    const player = state.trackPlayers.get(track.name); player.muted = !player.muted;
    applyTrackGains();
  });
  $('.track-volume', row).addEventListener('input', event => {
    const player = state.trackPlayers.get(track.name); player.volume = Number(event.target.value); applyTrackGains();
  });
  $('.wave-wrap', row).addEventListener('click', event => {
    const rect = event.currentTarget.getBoundingClientRect();
    seekMix((event.clientX - rect.left) / rect.width * state.trackDuration);
  });
}

async function loadTrackWaveform(name, generation) {
  const player = state.trackPlayers.get(name);
  if (!player) return;
  const { row, url } = player;
  const meta = trackPresentation[name] || { color: '#c8f36a' };
  try {
    const response = await fetch(url, { cache: 'no-store', signal: state.waveformAbort.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const decoded = await getAudioContext().decodeAudioData(arrayBuffer);
    if (generation !== state.audioGeneration) return;
    drawWaveform($('.wave-canvas', row), decoded, meta.color);
    $('.wave-loading', row).classList.add('hidden');
    state.trackDuration = Math.max(state.trackDuration, decoded.duration || 0);
    $('#total-time').textContent = formatTime(state.trackDuration);
    $('#transport-subtitle').textContent = `${state.trackPlayers.size} synced local stems · ${formatTime(state.trackDuration)}`;
  } catch (error) {
    if (generation !== state.audioGeneration || error.name === 'AbortError') return;
    $('.wave-loading', row).textContent = 'NO SE PUDO LEER EL WAV';
    $('.wave-loading', row).title = error.message;
  }
}

async function loadStemPlayers(project) {
  stopTransport();
  state.waveformAbort = new AbortController();
  const generation = state.audioGeneration;
  const pending = buildTrackRows(project);
  $('#mix-model').textContent = projectModelLabel(project);
  syncExportToProject(project);
  updateExportLinks();
  $('#transport-title').textContent = project.name;
  const refinement = project.metadata?.refinement;
  const hasVariants = project.stems?.some(stem => stem.hasRaw);
  $('#stem-variant-row').classList.toggle('hidden', !refinement || refinement.mode === 'off');
  $('#stem-variant').disabled = !hasVariants;
  $('#stem-variant').value = state.stemVariant;
  const seconds = Number(refinement?.maskedSeconds || 0).toFixed(1);
  $('#refinement-summary').textContent = hasVariants
    ? `${seconds} s revisados entre todas las pistas. Compara con el original; la duración y la sincronización se conservan.`
    : 'No se encontraron segmentos que cumplan los criterios. Se conserva el audio original.';
  await pending;
  if (generation !== state.audioGeneration) return;
}

function applyTrackGains() {
  for (const [name, player] of state.trackPlayers) {
    const status = trackState(name, player, state);
    player.gain.gain.setTargetAtTime(status.gain, getAudioContext().currentTime, .015);
    player.row.classList.toggle('is-dimmed', status.dimmed);
    player.row.classList.toggle('is-muted', status.muted);
    player.row.classList.toggle('is-solo', status.soloed);
    for (const [selector, enabled] of [['.track-solo', status.soloed], ['.track-mute', status.muted]]) {
      const control = $(selector, player.row);
      control.classList.toggle('selected', enabled);
      control.setAttribute('aria-pressed', String(enabled));
    }
  }
  syncPlaybackControls();
}

function isPlaying() { return [...state.trackPlayers.values()].some(player => !player.audio.paused && !player.audio.ended); }

function syncPlaybackControls() {
  const playing = isPlaying();
  $('#transport-play').textContent = playing ? 'Ⅱ' : '▶';
  $('#transport-play').setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
  $('#play-all-button').innerHTML = playing && !state.previewStem ? '<span>Ⅱ</span> Pausar mezcla' : '<span>▶</span> Escuchar mezcla';
  for (const [name, player] of state.trackPlayers) {
    const status = trackState(name, player, state);
    const active = !player.audio.paused && !player.audio.ended && status.gain > 0;
    const previewPlaying = state.previewStem === name && !player.audio.paused && !player.audio.ended;
    const button = $('.track-play', player.row);
    button.textContent = previewPlaying ? 'Ⅱ' : '▶';
    button.setAttribute('aria-pressed', String(previewPlaying));
    button.setAttribute('aria-label', `${previewPlaying ? 'Pausar' : 'Escuchar solo'} ${name}`);
    button.title = previewPlaying ? 'Pausar escucha individual' : `Escuchar solo ${name}`;
    player.row.classList.toggle('is-playing', active);
    $('.track-status', player.row).textContent = status.muted ? 'SILENCIADA' : status.dimmed ? 'FUERA DE ESCUCHA' : previewPlaying ? 'ESCUCHA INDIVIDUAL' : status.soloed ? 'SOLO' : active ? 'REPRODUCIENDO' : 'LISTA';
  }
}

function playbackPosition() {
  return [...state.trackPlayers.values()].find(player => !player.audio.paused && !player.audio.ended)?.audio.currentTime ?? state.currentTime;
}

async function previewTrack(name) {
  const player = state.trackPlayers.get(name);
  if (!player) return;
  if (player.muted) return toast('Pista silenciada', 'Desactiva M para escuchar esta pista.');
  if (state.previewStem === name && isPlaying()) { pauseMix(); return; }
  state.currentTime = playbackPosition();
  state.previewStem = name;
  await playMix();
}

async function playMix() {
  if (!state.trackPlayers.size) return toast('No hay stems', 'Separa una canción antes de reproducir pistas.');
  const ctx = getAudioContext();
  const request = ++state.playbackRequest;
  const generation = state.audioGeneration;
  state.currentTime = playbackPosition();
  const target = state.currentTime >= state.trackDuration - .03 ? 0 : state.currentTime;
  try {
    await ctx.resume();
    if (request !== state.playbackRequest || generation !== state.audioGeneration) return;
    if (state.sourceAudio) { state.sourceAudio.pause(); $('#preview-source').textContent = '▶'; }
    const selected = [];
    for (const [name, player] of state.trackPlayers) {
      if (state.previewStem && name !== state.previewStem) { player.audio.pause(); continue; }
      if (Math.abs(player.audio.currentTime - target) > .03 || player.audio.ended) player.audio.currentTime = target;
      selected.push(player);
    }
    applyTrackGains();
    const outcomes = await Promise.allSettled(selected.map(player => player.audio.play()));
    if (request !== state.playbackRequest || generation !== state.audioGeneration) return;
    if (outcomes.some(result => result.status === 'rejected')) {
      const reason = outcomes.find(result => result.status === 'rejected').reason;
      pauseMix();
      throw reason;
    }
    clearInterval(state.transportTimer);
    state.transportTimer = setInterval(updateTransport, 100);
    updateTransport();
  } catch (error) { if (request === state.playbackRequest) toast('No se pudo reproducir', error.message, 'error'); }
}

function pauseMix() {
  state.currentTime = playbackPosition();
  state.playbackRequest++;
  for (const player of state.trackPlayers.values()) player.audio.pause();
  clearInterval(state.transportTimer); state.transportTimer = null;
  syncPlaybackControls();
}

function stopTransport() {
  state.audioGeneration++;
  state.waveformAbort?.abort();
  pauseMix(); clearInterval(state.transportTimer); state.transportTimer = null;
  for (const player of state.trackPlayers.values()) { player.audio.pause(); player.audio.removeAttribute('src'); player.audio.load(); player.source.disconnect(); player.gain.disconnect(); }
  state.trackPlayers.clear(); state.solo.clear(); state.previewStem = null; state.currentTime = 0;
}

function toggleMix(returnToMix = false) {
  if (!state.trackPlayers.size) return;
  if (returnToMix && state.previewStem) {
    state.currentTime = playbackPosition(); state.previewStem = null; playMix();
  } else if (isPlaying()) pauseMix(); else playMix();
}

function updateTransport() {
  const players = [...state.trackPlayers.values()];
  if (!players.length) return;
  const playing = players.find(item => !item.audio.paused && !item.audio.ended);
  const current = playing?.audio.currentTime ?? (players.some(item => item.audio.ended) ? state.trackDuration : state.currentTime);
  state.currentTime = current;
  $('#current-time').textContent = formatTime(current);
  $('#timeline').value = String(state.trackDuration ? (current / state.trackDuration) * 1000 : 0);
  for (const { audio, row } of players) {
    const playhead = $('.wave-playhead', row);
    playhead.style.display = state.trackDuration ? 'block' : 'none';
    playhead.style.left = `${state.trackDuration ? Math.min(100, current / state.trackDuration * 100) : 0}%`;
    if (!audio.paused && Math.abs(audio.currentTime - current) > .09) audio.currentTime = current;
  }
  syncPlaybackControls();
  if (!playing) { clearInterval(state.transportTimer); state.transportTimer = null; }
}

function seekMix(seconds) {
  const target = Math.max(0, Math.min(state.trackDuration || 0, seconds));
  state.currentTime = target;
  for (const player of state.trackPlayers.values()) {
    try { player.audio.currentTime = target; } catch { }
  }
  updateTransport();
}

function startSourcePreview() {
  if (!state.project) return;
  if (state.project.mediaKind === 'video' && !state.project.hasAudio) return toast('Extrae el audio primero', 'La vista previa se habilita cuando el audio esté extraído.');
  if (state.sourceAudio && !state.sourceAudio.paused) { state.sourceAudio.pause(); $('#preview-source').textContent = '▶'; return; }
  pauseMix();
  if (!state.sourceAudio) state.sourceAudio = new Audio(`/api/projects/${state.project.id}/original`);
  if (!state.sourceAudio.src || state.sourceAudio.src.endsWith('/undefined')) return toast('Vista previa no disponible', 'El original de vídeo o audio no se puede reproducir en el navegador.');
  state.sourceAudio.src = `/api/projects/${state.project.id}/audio`;
  state.sourceAudio.play().then(() => { $('#preview-source').textContent = 'Ⅱ'; }).catch(error => toast('No se pudo reproducir', error.message, 'error'));
  state.sourceAudio.onended = () => { $('#preview-source').textContent = '▶'; };
}

function setProfile(profile) {
  state.profile = profile;
  $$('.profile-option').forEach(button => button.classList.toggle('active', button.dataset.profile === profile));
  const model = selectedModel();
  const notes = {
    performance: `CPU · ${state.threads} hilos · shifts 0 · overlap 0.1 · WAV 16-bit · más rápido`,
    balanced: `CPU · ${state.threads} hilos · shifts 0 · overlap 0.25 · WAV 24-bit · equilibrio`,
    maximum: model.ensemble
      ? `CPU · ${state.threads} hilos · ensemble ${model.cpuCost || 'alto'} · overlap 0.5 · WAV 32-bit float`
      : `CPU · ${state.threads} hilos · 2 shifts · overlap 0.5 · WAV 32-bit float`
  };
  $('#profile-note').textContent = `${notes[profile]} · 1 trabajo simultáneo`;
}

function setMode(mode) {
  state.mode = mode;
  $$('.mode-option').forEach(button => button.classList.toggle('selected', button.dataset.mode === mode));
  $('#source-options-block').classList.toggle('hidden', mode !== 'advanced');
  if (mode === 'advanced') renderSourceOptions();
}

function bindEvents() {
  $('#browse-button').addEventListener('click', () => $('#file-input').click());
  $('#browse-cta').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', event => importFile(event.target.files?.[0]));
  const drop = $('#import-panel');
  for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('dragging'); });
  for (const name of ['dragleave', 'drop']) drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('dragging'); });
  drop.addEventListener('drop', event => importFile(event.dataTransfer.files?.[0]));
  $$('.nav-item[data-view]').forEach(button => button.addEventListener('click', () => selectView(button.dataset.view)));
  $$('[data-open-view]').forEach(button => button.addEventListener('click', () => selectView(button.dataset.openView)));
  $('#sidebar-refresh').addEventListener('click', loadProjects);
  $('#model-select').addEventListener('change', event => { localStorage.setItem('aims-model', event.target.value); renderModelHealth(); setProfile(state.profile); if (state.mode === 'advanced') renderSourceOptions(); });
  $$('.mode-option').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
  $$('.profile-option').forEach(button => button.addEventListener('click', () => setProfile(button.dataset.profile)));
  $('#separate-button').addEventListener('click', startSeparation);
  $('#cancel-job').addEventListener('click', cancelJob);
  $('#threads-select').addEventListener('change', event => { state.threads = Number(event.target.value) === 6 ? 6 : 4; localStorage.setItem('aims-threads', String(state.threads)); refreshSystem(); setProfile(state.profile); });
  $('#play-all-button').addEventListener('click', () => toggleMix(true));
  for (const input of $$('#export-options select, #export-options input')) input.addEventListener('change', updateExportControls);
  $('#download-all').addEventListener('click', event => { if (exportRequiresFfmpeg()) { event.preventDefault(); toast('FFmpeg necesario', 'Instala FFmpeg y actualiza el estado del sistema para usar esta opción de exportación.', 'error'); } });
  $('#track-list').addEventListener('click', event => { if (event.target.closest('.track-download') && exportRequiresFfmpeg()) { event.preventDefault(); toast('FFmpeg necesario', 'Instala FFmpeg y actualiza el estado del sistema para usar esta opción de exportación.', 'error'); } });
  $('#transport-play').addEventListener('click', () => toggleMix());
  $('#seek-back').addEventListener('click', () => seekMix(playbackPosition() - 10));
  $('#seek-forward').addEventListener('click', () => seekMix(playbackPosition() + 10));
  $('#timeline').addEventListener('input', event => seekMix(Number(event.target.value) / 1000 * state.trackDuration));
  $('#master-volume').addEventListener('input', event => { state.masterVolume = Number(event.target.value); state.masterMuted = false; applyTrackGains(); });
  $('#transport-volume').addEventListener('click', () => { state.masterMuted = !state.masterMuted; $('#transport-volume').textContent = state.masterMuted ? '◌' : '◖'; applyTrackGains(); });
  $('#preview-source').addEventListener('click', startSourcePreview);
  $('#stem-variant').addEventListener('change', event => {
    const target = playbackPosition();
    state.stemVariant = event.target.value === 'raw' ? 'raw' : 'refined';
    loadStemPlayers(state.project).catch(error => toast('No se pudo cargar la versión', error.message, 'error'));
    seekMix(target);
    updateExportLinks();
  });
  $('#change-separation').addEventListener('click', () => {
    $('#setup-grid').classList.remove('hidden');
    $('#action-row').classList.remove('hidden');
    $('#setup-grid').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  });
  $('#refine-stems').addEventListener('click', startRefinement);
  $('#remove-source').addEventListener('click', async () => {
    if (!state.project) return;
    if (!confirm('¿Eliminar este proyecto local y sus archivos guardados?')) return;
    try { await api(`/api/projects/${state.project.id}`, { method: 'DELETE' }); applyProject(null); await loadProjects(); toast('Proyecto eliminado', 'Los archivos locales de este proyecto se han borrado.', 'success'); }
    catch (error) { toast('No se pudo eliminar', error.message, 'error'); }
  });
  $('#cancel-model-operation').addEventListener('click', async () => {
    try { await api('/api/models/operation', { method: 'DELETE' }); state.modelOperation = { ...state.modelOperation, status: 'cancelled' }; $('#model-operation').classList.add('hidden'); renderModelCatalog(); }
    catch (error) { toast('No se pudo cancelar la descarga', error.message, 'error'); }
  });
  $('#refresh-system').addEventListener('click', async () => { await refreshSystem(); await refreshModels(); toast('Sistema actualizado', 'Se ha vuelto a comprobar el entorno local.', 'success'); });
  $('#clean-temp').addEventListener('click', async () => {
    if (!confirm('¿Limpiar solo los archivos temporales? Los originales y stems de proyectos se conservarán.')) return;
    try { const result = await api('/api/temp', { method: 'DELETE' }); toast('Temporales limpiados', `${result.deleted} archivo(s) temporal(es) eliminado(s).`, 'success'); }
    catch (error) { toast('No se pudieron limpiar los temporales', error.message, 'error'); }
  });
  $('#help-button').addEventListener('click', () => toast('AI Music Separator Studio', isStaticHosting ? hostingMessage : 'Importa un audio, instala HTDemucs desde AI Models y luego ejecuta la separación local. No se simulan resultados.'));
}

async function init() {
  for (const input of $$('#export-options select, #export-options input')) {
    const key = `aims-export-${input.id.replace('export-', '')}`;
    const remembered = localStorage.getItem(key);
    if (remembered === null) continue;
    if (input.type === 'checkbox') input.checked = remembered === 'true';
    else if ([...input.options].some(option => option.value === remembered)) input.value = remembered;
  }
  updateExportControls();
  bindEvents();
  if (isStaticHosting) {
    showStaticHosting();
    return;
  }
  const rememberedModel = localStorage.getItem('aims-model');
  if (rememberedModel && $('#model-select').querySelector(`option[value="${CSS.escape(rememberedModel)}"]`)) $('#model-select').value = rememberedModel;
  setMode('quick'); setProfile(state.profile);
  await Promise.all([refreshSystem(), loadProjects(), refreshModels()]);
  const saved = localStorage.getItem('aims-current-project');
  if (saved && state.projects.some(project => project.id === saved)) await openProject(saved);
}

init();
