# Estado de desarrollo

Última actualización: 17 de noviembre de 2026.

## Implementado

- Aplicación web local independiente, con interfaz propia, servidor Node y biblioteca SQLite. El servidor solo escucha en `127.0.0.1`.
- Importación de audio/vídeo, validación básica, persistencia local y selección de pista de audio de vídeo cuando FFmpeg/ffprobe están disponibles.
- Integración real con Demucs v4 en CPU: un trabajo simultáneo, cuatro hilos por defecto, opción de seis, perfiles de rendimiento y control preventivo de RAM.
- Catálogo para HTDemucs, HTDemucs Fine-Tuned, MDX-Extra, MDX-Extra-Q y HTDemucs 6S, con consulta de tamaño y descarga explícita de pesos oficiales.
- Perfiles reales: Rendimiento usa PCM16/overlap 0.1; Equilibrado PCM24/overlap 0.25; Máximo float32/overlap 0.5 y dos shifts en modelos simples. Los ensembles no añaden shifts. Modelo, formato y parámetros quedan en los metadatos.
- Controles preventivos por modelo de RAM libre y espacio de disco, incluyendo originales y copias si se activa limpieza. Directorios aislados por trabajo; cancelación `cancelling` hasta que Python cierra, sin permitir otra separación pesada en ese intervalo.
- Revisión de silencios opcional durante o después de separar. Usa bloques pequeños de audio, nivel, duración y contenido tonal en ambos canales para conservar material dudoso. Los stems originales se conservan, con selector A/B para reproducción y exportación individual/ZIP. El modo de residuo es experimental y no infiere el valor musical del sonido.
- Reproducción sincronizada de stems WAV, Solo/Mute/volumen, búsqueda temporal y formas de onda calculadas desde los archivos reales.
- Play individual al lado del nombre, pausa individual, Solo múltiple y Mute prioritario. Las pistas silenciadas/excluidas de Solo se ven grises. Al volver a mezcla se conserva la posición. Los errores de reproducción se muestran, y las formas de onda se decodifican secuencialmente sin retener buffers completos.
- Animaciones ligeras de entrada/reproducción y soporte de movimiento reducido. Diseño probado a 390 px; el acceso de red desde un teléfono sigue sin habilitarse, ya que el servicio escucha solo en loopback.
- Descarga individual y ZIP; conversiones de exportación a WAV, FLAC, MP3, AAC/M4A, OGG y AIFF con opciones de frecuencia, profundidad, canales y normalización mediante FFmpeg.
- Scripts `INSTALL.bat`, `START.bat`, `STOP.bat` y guías de instalación/solución de problemas.

## Entorno verificado

- Windows 10 x64, Node.js `v26.13.0`, Python `3.11.9`, PyTorch/torchaudio `2.5.1+cpu`, Demucs `4.0.1`.
- PyTorch reporta AVX2 y cuatro hilos. El CPU detectado es Intel Core i7-4770, con 4 núcleos físicos, 8 procesadores lógicos y 3.4 GHz reportados por WMI; el sistema tiene unos 7.8 GB de RAM.
- WMI verificó Intel HD Graphics 4600, controlador `20.19.15.5171` y 1 GB de memoria reportada. La inferencia sigue en CPU; CUDA/XPU no se activan.
- Modelos: HTDemucs instalado (84,141,911 bytes) y HTDemucs Fine-Tuned instalado (336,565,084 bytes en cuatro pesos); MDX-Extra no instalado; MDX-Extra-Q no disponible por falta de DiffQ compilado; HTDemucs 6S no instalado.
- FFmpeg/ffprobe `9.0.2` están instalados para pruebas. El build full de Gyan tiene licencia GPL-3.0 y no se redistribuye con la aplicación.

## Pruebas realizadas

- `node --check` pasó para el servidor, la interfaz y los scripts de smoke; `py_compile` pasó para `runner.py`.
- `node scripts/smoke.mjs`: salud y hardware, página local, catálogo, importación WAV, lectura local, rechazo de stems inexistentes y limpieza del proyecto temporal.
- `node scripts/engine-smoke.mjs htdemucs 4` y `node scripts/engine-smoke.mjs htdemucs 6`: ambas ejecuciones separaron la misma mezcla sintética de 5 s y generaron vocals, drums, bass y other en WAV estéreo 44.1 kHz, 16 bit y 5 s. En repeticiones con el modelo ya en caché, 4 hilos tardó 17.0 s y 6 hilos 12.5 s; la primera ejecución fría de 4 hilos tardó 47.1 s. Es una prueba corta con una medición caliente por configuración, no una referencia definitiva para canciones.
- `node scripts/app-separation-smoke.mjs`: el flujo completo de la API terminó un trabajo HTDemucs, registró los cuatro stems y sirvió sus cabeceras mediante respuestas HTTP 206.
- `node scripts/video-smoke.mjs`: importó un MP4 con dos pistas de distinta frecuencia, seleccionó la segunda y comprobó que FFmpeg extrajo el tono de 880 Hz.
- `node scripts/export-smoke.mjs`: validó WAV 24-bit mono/48 kHz, FLAC 24-bit, MP3 normalizado, AAC/M4A, OGG Vorbis, AIFF, ZIP WAV y ZIP MP3 con ffprobe y Python.
- `node scripts/cancel-smoke.mjs`: rechazó un segundo trabajo simultáneo y canceló el HTDemucs activo por la API; el estado quedó `cancelled` y no se registraron stems.
- `node scripts/engine-smoke.mjs htdemucs_ft 4`: cuatro WAV válidos con el ensemble oficial. Una ejecución corta de 5 s tardó 51.0 s; otra auditoría con distintos parámetros tardó 27.6 s. Son comprobaciones de integridad, no una comparación musical ni un benchmark uniforme.
- `node scripts/quality-api-smoke.mjs`: pasó el flujo Fine-Tuned máximo con cuatro stems float32 y conversión solicitada a PCM16. Tras elevar la protección a 3 GB libres, su repetición se omitió (`SKIPPED`) por disponer de aproximadamente 2.3 GB; no se eludió esa protección.
- `node scripts/quality-guard-smoke.mjs`: pasó el rechazo HTTP 409 de Fine-Tuned con menos de 3 GB libres. `SKIPPED` si hay suficiente memoria no equivale a una prueba de la guarda.
- `python scripts/residue-refinement-smoke.py` usando `.venv`: pasó silencio casi digital, reducción del ruido de control y conservación exacta de contenido fuera de intervalos. Preservó tono a −80 dBFS, incluso en un canal junto a ruido más fuerte en el otro, y ruido breve menor de 1.2 s. El original siguió idéntico. Esto verifica la política acústica, no calidad musical general.
- `node scripts/mixer-refinement-smoke.mjs`: pasó en Chromium real. Revisión de cuatro pistas de control, comparación byte a byte del original, variantes de WAV y ZIP, Play/pausa individual, reproducción sincronizada dentro de 120 ms, Solo múltiple, Mute gris, nodos Gain reales, búsqueda temporal, cambio de variante, ausencia de desbordamiento a 390 px y movimiento reducido. Capturas en `test-results/`, ignoradas por Git.
- `node scripts/app-separation-smoke.mjs` se repitió con HTDemucs Equilibrado y revisión conservadora: produjo cuatro WAV PCM24 estéreo/44.1 kHz y metadatos de revisión reales.
- `scripts/smoke.mjs` y `scripts/cancel-smoke.mjs` volvieron a pasar tras integrar la revisión y migrar SQLite con la ruta del stem original.
- `INSTALL.bat` se ejecutó de nuevo correctamente: confirmó AVX2, Demucs, FFmpeg y ffprobe; DiffQ quedó como dependencia opcional porque no está instalado MSVC Build Tools.
- El ciclo `STOP.bat` → `START.bat` pasó: detuvo el servidor, lo inició oculto, abrió la URL local y respondió con Python/FFmpeg/ffprobe disponibles.
- Consultas HEAD al catálogo oficial: HTDemucs 84,141,911 bytes; MDX-Extra-Q 167,578,560 bytes.
- Se intentó instalar DiffQ 0.2.4 para MDX-Extra-Q. Su extensión C++ no pudo compilarse porque falta Microsoft Visual C++ 14.0/Build Tools. La app detecta este requisito y bloquea instalar pesos o iniciar el modelo sin esa dependencia.

## Pendiente

- Ejecutar HTDemucs y exportar sus resultados con una canción real autorizada; la mezcla sintética solo comprueba el flujo técnico, no la calidad musical.
- Instalar MSVC Build Tools y DiffQ para poder probar MDX-Extra-Q.
- Probar HTDemucs 6S y evaluar guitarra/piano. La comparación de hilos usa una mezcla sintética corta y necesita repetirse con material musical autorizado.
- Probar un vídeo de usuario autorizado con múltiples pistas; el contenedor sintético ya confirmó selección/extracción y metadatos básicos.
- Escuchar comparaciones A/B con música autorizada y stems de referencia. La reproducción, sincronización, Solo/Mute y volúmenes ya se verificaron en navegador con WAV de control; queda evaluar subjetivamente música real y la recuperación de trabajos tras cerrar el servidor.
- Medir memoria pico con canciones de distinta duración. La prueba corta de Fine-Tuned dejó alrededor de 0.7 GB libres partiendo de unos 2.1 GB, motivando la guarda de 3 GB. El rechazo con memoria baja sí se probó.
- Comparar exportaciones desde stems reales y revisar duración, silencios y reconstrucción aproximada. El smoke de formatos usó stems WAV de control importados, no resultados HTDemucs.
- La revisión visual/interactiva se realizó con Chromium local; la interfaz es propia y no se ha reutilizado código de una web de referencia.

## Limitaciones conocidas

- El test HTDemucs usó audio sintético de control; no se afirma calidad de separación en canciones reales.
- MDX-Extra-Q requiere DiffQ y en Windows su compilación necesita MSVC Build Tools. HTDemucs funciona sin esa dependencia.
- DiffQ usa CC-BY-NC 4.0; su licencia no debe confundirse con la licencia MIT de Demucs.
- El refinamiento de residuos usa criterios acústicos conservadores, no un clasificador entrenado para decidir qué contenido tiene valor artístico. Puede confundir un ambiente extremadamente tenue con residuo; por eso requiere selección explícita y preserva el original.
- Los trabajos anteriores completados se conservan en el directorio del proyecto. La biblioteca muestra la última ejecución; no borra automáticamente resultados previos al volver a separar. Eliminar el proyecto borra su historial de archivos.
- FFmpeg debe instalarse aparte. La aplicación no incluye ni redistribuye binarios de FFmpeg.
- El gestor permite instalar y eliminar pesos, pero no actualizar automáticamente. Para actualizar hay que eliminar y volver a instalar.
- No hay segmentación manual, detección fina de instrumentos ni Smart Stem Recovery.
- El equipo disponible reporta i7-4770/HD 4600, distinto del i7-4790/HD 4200 indicados en el encargo; no se puede asumir que sea el PC final.
