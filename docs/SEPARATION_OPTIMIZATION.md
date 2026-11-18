# Evaluación del motor de separación

18 de noviembre de 2026. Las mediciones completas están en `benchmarks/separation-2026-11-18.json`. Los audios de prueba y los resultados WAV permanecen en `data/temp/separation-benchmark`, excluido de Git.

## A. Modelos analizados

El servidor Node inicia un proceso Python por trabajo. PyTorch 2.5.1 y Demucs 4.0.1 realizan la separación en CPU. El navegador reproduce los resultados. La publicación de GitHub Pages aloja la interfaz y sigue pendiente de un servidor de inferencia para procesar online.

La subida manual integrada desde GitHub incorpora también una copia anterior en `separation/`. La ruta utilizada por `server.mjs` es `backend/separation/runner.py`, que carga `backend/separation/inference.py`. Esa copia adicional contiene los mismos nombres de modelos y queda fuera de la ruta activa de la aplicación.

| Modelo del catálogo | Red y pesos oficiales | Fuentes y situación verificada |
| --- | --- | --- |
| `htdemucs` | Hybrid Transformer Demucs, doble rama temporal/espectral y Transformer entre dominios. Firma `955717e8`. | drums, bass, other, vocals. Instalado y evaluado con audio real. |
| `htdemucs_ft` | Cuatro HTDemucs afinados por fuente. Firmas `f7e0c4bc`, `d12395a8`, `92cfc3b6`, `04573f0d`. La matriz oficial selecciona una fuente de cada red. | Cuatro fuentes. Instalado y evaluado con audio real. |
| `mdx_extra` | Ensemble de cuatro Hybrid Demucs de la familia MDX de Demucs. Firmas `e51eebcc`, `a1d90b5c`, `5d2d6c55`, `cfa93e08`. Configuración oficial de 44 segundos. | Cuatro fuentes. Pesos ausentes, evaluación de audio pendiente. |
| `mdx_extra_q` | Ensemble Hybrid Demucs con checkpoints comprimidos mediante DiffQ. Firmas `83fc094f`, `464b36d7`, `14fc6a69`, `7fd6ef75`. Configuración oficial de 44 segundos. | Cuatro fuentes. Caché incompleta y DiffQ ausente. |
| `htdemucs_6s` | HTDemucs experimental con seis salidas, firma `5c90dfd2`. | Añade guitar y piano. Pesos ausentes. Evaluación por instrumento pendiente. |

La resolución de nombres y pesos utiliza los YAML y `files.txt` del paquete instalado. Los checkpoints proceden de `dl.fbaipublicfiles.com/demucs`. La separación exige la caché completa antes de cargar. Demucs usa licencia MIT. DiffQ tiene condiciones CC-BY-NC 4.0 que deben revisarse para uso comercial.

El refinamiento opcional de silencios es procesamiento convencional con NumPy y SoundFile. Usa nivel, duración y planitud espectral. Su capacidad se limita a los criterios acústicos implementados.

La conversión de entrada conserva la ruta oficial de FFmpeg, con fallback de torchaudio y resampling Julius. Se mantienen la frecuencia del modelo de 44,1 kHz, el procesamiento estéreo, STFT/iSTFT, padding y overlap-add triangular de Demucs. En HTDemucs, el tamaño entrenado de 7,8 segundos limita el contexto. Cambiar la FFT o las ventanas de una red entrenada requiere validar sus pesos y su reconstrucción.

Fuentes primarias consultadas

- [Código y descripción oficial de Demucs](https://github.com/facebookresearch/demucs)
- [Hybrid Transformers for Music Source Separation](https://arxiv.org/abs/2211.08553)
- [Tutorial oficial de torchaudio con referencias](https://docs.pytorch.org/audio/2.5.0/tutorials/hybrid_demucs_tutorial.html)
- [Muestras oficiales de HTDemucs](https://ai.honu.io/papers/htdemucs/)

## B. Defectos detectados

1. La normalización dividía por la desviación estándar de la suma mono. Silencio digital y canales opuestos podían producir valores no finitos y terminar en `AssertionError`. Ambos fallos se reprodujeron con la versión original.
2. Al desnormalizar se añadía la media de la mezcla a cada fuente. La suma de cuatro pistas recibía cuatro veces ese componente continuo.
3. `save_audio` reescalaba cada pista por separado al encontrar picos altos. Eso podía cambiar las relaciones de nivel entre instrumentos. También atenuaba WAV float que admiten muestras superiores a 1.
4. La planificación con un trabajador retenía resultados de `Future` ya completados. Los ensembles cargaban todas las redes simultáneamente.
5. Los shifts tenían variación aleatoria entre trabajos, dificultando comparaciones reproducibles.

Las filtraciones restantes dependen de los pesos, el dominio de entrenamiento, el contexto disponible y la superposición entre instrumentos. La guitarra y los teclados comparten el grupo `other` en los modelos de cuatro fuentes. La documentación oficial advierte de filtraciones y artefactos en el piano de 6S.

## C. Mejoras implementadas

- Normalización con fallback de energía estéreo cuando se cancela la suma mono. La comprobación de silencio exige una señal exactamente constante, conservando contenido muy tenue.
- Silencio y DC constantes eluden la inferencia. El DC se conserva una vez en `other`.
- La restauración de la media de audio normal también se aplica una sola vez en `other`.
- Las pistas PCM comparten un único factor de atenuación si hace falta margen. Las pistas float conservan sus valores originales. El informe guarda pico, factor y política aplicada.
- Los checkpoints oficiales del ensemble se cargan, ejecutan y liberan secuencialmente. Se conservan sus pesos por fuente y el orden de acumulación.
- Los fragmentos se evalúan bajo `torch.inference_mode`, con el ejecutor secuencial diferido oficial. La política de hilos respeta los núcleos asignados y la cuota cgroup v2 cuando está disponible.
- Los shifts utilizan semilla 0 reproducible. Los informes registran parámetros efectivos, firmas de pesos, tamaño de segmento, normalización y tiempos.

Estas modificaciones actúan sobre la inferencia y la reconstrucción. Los pesos neuronales conservan sus valores preentrenados.

## D. Método de evaluación

Se conservaron `runner.py` y `stem_refinement.py` originales del commit `8e41a0b` en `data/temp/optimization-baseline`. El SHA-256 original del runner es `58eeaa063e7376e90288f9a30953a6870e1391b73e7bf50d7729cca634d0e02e`.

Hardware medido en Windows con Intel i7-4770, AVX2, 4 núcleos físicos, 8 lógicos y unos 7,8 GiB totales. Los ensayos usan cuatro hilos, un trabajo y FP32. CUDA aparece deshabilitado en el runtime instalado. El monitor de los benchmarks reserva memoria para el sistema. El filtro de admisión de trabajos de la aplicación sigue activo.

Material utilizado

- Cinco segundos de A Classic Education — NightOwl. Se sumaron los cuatro WAV de referencia del tutorial oficial de torchaudio. Se comparan exactamente las mismas muestras antes y después. Son datos pertenecientes al conjunto de entrenamiento de MUSDB, lo que limita las conclusiones sobre generalización.
- Doce segundos, desde el segundo 5, de The Easton Ellises — Falcon 69. Se decodificaron las cuatro referencias MP3 de la página oficial y se creó la mezcla como suma de esos stems. Los resultados corresponden a esa mezcla de referencias con pérdida, con las limitaciones del códec y del extracto. La página identifica la licencia CC BY-NC-SA.
- Repetición de NightOwl hasta 20 segundos para ejercitar varios fragmentos. Es una prueba técnica de uniones.
- Extracto privado de 20 segundos del audio que ya estaba en el proyecto. Se utilizó para comprobar integridad, sin stems de referencia.
- Silencio, contrafase, contenido muy tenue, NaN, infinitos y controles sintéticos de ganancia, DC y formatos.

Se calcula SI-SDR conjunto estéreo tras centrar referencia y predicción. Se registran además error RMS contra referencia, error de primeras diferencias, error del canal lateral y error de la suma. Las primeras diferencias son una comprobación de cambios temporales, con alcance distinto a una prueba perceptual de transitorios. La duración se comprueba en muestras y la validez exige muestras finitas.

Las mediciones de RAM son el máximo working set del proceso Python en Windows. También se registra commit pico. La primera ejecución en frío se conserva separada. Los tiempos dependen de cachés, presión de memoria y actividad del sistema. El pequeño número de repeticiones permite describir los ensayos realizados.

## E. Configuración por modelo

Los perfiles de rendimiento y equilibrado mantienen su uso de overlap 0,1 y 0,25. La elección del perfil máximo se contrasta con las pruebas de TTA. La segmentación utiliza los tamaños oficiales de cada arquitectura y la limpieza permanece opcional.

| Modelo | Perfil máximo aplicado | Justificación y alcance |
| --- | --- | --- |
| HTDemucs | 2 shifts, overlap 0,5, float32 | Ajuste ya disponible. En Falcon mejora las cuatro fuentes. En NightOwl empeora batería y bajo. Mantener el perfil equilibrado permite comparar. |
| HTDemucs Fine-Tuned | **2 shifts, overlap 0,5, float32** | Cambio de 0 a 2 shifts. Mejora siete de ocho puntuaciones SI-SDR en dos extractos frente al máximo anterior. El pequeño retroceso de batería de Falcon se cuantifica abajo. |
| MDX-Extra | 0 shifts, overlap 0,5, segmento oficial de 44 s | Configuración conservada hasta disponer de evaluación con sus pesos. |
| MDX-Extra-Q | 0 shifts, overlap 0,5, segmento oficial de 44 s | Evaluación pendiente de DiffQ y caché completa. |
| HTDemucs 6S | 2 shifts, overlap 0,5, tamaño entrenado del checkpoint | Configuración conservada. Faltan referencias de guitarra y piano y sus pesos instalados. |

El perfil equilibrado continúa con 0 shifts y overlap 0,25 para todos. Las mejoras de normalización, DC y ganancia se aplican en todos los perfiles. Estas selecciones son configuraciones de trabajo con la evidencia disponible. La variedad musical requiere ampliar la validación.

### Resultados de calidad

SI-SDR en dB. Cada celda presenta el máximo anterior de Fine-Tuned con 0 shifts y overlap 0,5, seguido del candidato de 2 shifts con el mismo overlap.

| Referencia | Batería | Bajo | Other | Voz |
| --- | --- | --- | --- | --- |
| NightOwl, 5 s | 3,944 → 4,230 | 17,981 → 18,180 | 8,477 → 8,525 | 7,903 → 7,980 |
| Falcon 69, 12 s | 9,744 → 9,735 | 9,179 → 9,271 | 0,609 → 0,774 | 1,935 → 2,297 |

El promedio de las cuatro fuentes aumenta 0,153 dB en NightOwl y 0,152 dB en Falcon. La batería de Falcon pierde 0,009 dB. El error RMS lateral de la voz de NightOwl aumenta aproximadamente 0,000046 en amplitud aunque su SI-SDR mejora. Estos compromisos acotan la elección del perfil máximo. La comparación evalúa la recuperación de los stems de estos extractos. La evaluación auditiva y la reducción de filtraciones por instrumento necesitan más datos.

Para HTDemucs, 0 shifts/overlap 0,25 frente a 2 shifts/overlap 0,5 produce las siguientes puntuaciones.

| Referencia | Batería | Bajo | Other | Voz |
| --- | --- | --- | --- | --- |
| NightOwl | −0,858 → −1,033 | 15,245 → 15,137 | 8,178 → 8,239 | 7,519 → 7,535 |
| Falcon 69 | 9,528 → 9,551 | 9,059 → 9,160 | 0,077 → 0,263 | −0,183 → 0,250 |

Aumentar solo overlap a 0,5 en NightOwl da −0,872 / 15,237 / 8,181 / 7,516 dB. Por eso el perfil equilibrado sigue siendo una alternativa relevante.

Con iguales parámetros, la orquestación secuencial produjo WAV idénticos muestra a muestra en los ensayos iniciales de HTDemucs y Fine-Tuned, incluido el control de varios bloques. Las correcciones posteriores de DC cambian ligeramente los samples. El SI-SDR centrado queda igual dentro de 0,000001 dB en NightOwl y Falcon. En NightOwl el error de suma de HTDemucs pasa de 0,0033063 a 0,0032429 RMS tras restaurar el DC una sola vez.

Los controles sintéticos comprueban que un pico float de 1,2 conserva ese valor. Para PCM, todas las fuentes reciben el mismo factor. Una pareja con relación de amplitud 2 mantiene esa relación, frente a aproximadamente 1,65 con el reescalado independiente anterior. Una señal constante de 0,125 suma 0,125 entre las pistas, frente a 0,5 con la restauración antigua de cuatro fuentes. Se corrigieron las ejecuciones que fallaban con silencio y contrafase.

### Tiempo y memoria

Mediciones de la orquestación con 0 shifts, overlap 0,25 y salida float32 en NightOwl. Medianas de 3 repeticiones para HTDemucs y 2 para Fine-Tuned. Corresponden al aislamiento de la mejora de memoria anterior a los ajustes de DC y ganancia.

| Motor | Tiempo total anterior → secuencial | Inferencia anterior → secuencial | Working set pico anterior → secuencial |
| --- | --- | --- | --- |
| HTDemucs | 15,69 → 15,64 s | 11,65 → 11,22 s | 1183,8 → 1180,9 MiB |
| Fine-Tuned | 32,57 → 32,44 s | 24,32 → 23,47 s | 1683,1 → 1275,4 MiB |

El working set de Fine-Tuned disminuye aproximadamente 24 %. El tiempo total se mantiene similar. El primer arranque frío de HTDemucs tardó 68,56 s y queda excluido de esas medianas.

En la comparación de calidad de Fine-Tuned con overlap fijo de 0,5, el tiempo total medido pasa de 44,37 a 83,93 s para NightOwl y de 75,64 a 157,25 s para Falcon al añadir dos shifts. Son ejecuciones individuales. El ensayo Falcon con overlap 0,25 coincidió parcialmente con una separación de usuario y queda excluido de conclusiones de velocidad. El monitor detuvo la secuencia al reducirse la memoria disponible y se reanudó al terminar el trabajo de la web.

### Regresiones y comprobación en la aplicación

- `scripts/inference-regression.py` pasó normalización, contrafase, música tenue, entradas inválidas, shifts, uniones de fragmentos, pesos de ensemble, carga secuencial, contratos de cuatro/seis fuentes, PCM16/PCM24/float32, DC y ganancia compartida.
- `scripts/app-separation-smoke.mjs` pasó la separación real HTDemucs equilibrada, revisión de silencios, metadatos efectivos y reproducción HTTP 206 de cuatro WAV PCM24.
- `scripts/cancel-smoke.mjs` pasó rechazo de una segunda separación simultánea y cancelación sin registrar stems incompletos.
- Tras recargar el servidor, `scripts/quality-api-smoke.mjs` indicó `SKIPPED` con 2,92 GiB disponibles frente a los 3 GiB exigidos por la aplicación. El ensayo de Fine-Tuned máximo mediante API queda pendiente de esa disponibilidad. Los ensayos de audio de Fine-Tuned se hicieron con el comando Python y el monitor del benchmark.
- `scripts/quality-guard-smoke.mjs` pasó el rechazo con 2,87 GiB libres. Su primera ejecución encontró una carrera entre la consulta de memoria y la admisión, que aceptó el trabajo al aumentar la RAM. Se corrigió el test para cancelar ese trabajo de control y marcar esa condición como `SKIPPED`. El proyecto temporal de esa ejecución quedó eliminado.
- Una separación de usuario de 152,979773 s terminó con cuatro stems PCM24 y 6.746.408 muestras por pista. El informe registró un pico previo de 1,406 y ganancia común 0,704192. Se consultaron sus metadatos para verificar la ruta real de la web.

## F. Límites y siguientes evaluaciones

Faltan un corpus independiente amplio, stems de rock y metal con guitarras distorsionadas, y una escucha A/B controlada. Los dos fragmentos públicos y el extracto privado ofrecen una cobertura limitada. Las muestras de Falcon proceden de un grupo de rock, pero esa referencia aislada resulta insuficiente para caracterizar el género.

La evaluación musical de MDX-Extra, MDX-Extra-Q y 6S requiere sus pesos completos. Las pruebas de regresión con redes pequeñas verifican planificación, pesos y contratos de cuatro y seis salidas. Su alcance es la corrección del motor.

La arquitectura BS-RoFormer estima máscaras complejas por bandas mediante Transformers. Mel-Band RoFormer utiliza bandas mel solapadas. Ambas merecen una comparación posterior con checkpoints concretos y datos independientes. La implementación de referencia consultada tiene licencia MIT, y cada checkpoint necesita revisión propia de licencia, procedencia, configuración, fuentes y memoria. El tamaño y la VRAM dependen del checkpoint y de los fragmentos elegidos. La compatibilidad requiere otro adaptador de inferencia.

Fuentes primarias para la evaluación de alternativas

- [BS-RoFormer](https://arxiv.org/abs/2309.02612)
- [Mel-Band RoFormer](https://arxiv.org/abs/2310.01809)
- [Implementación y pesos de terceros enlazados por BS-RoFormer](https://github.com/lucidrains/BS-RoFormer)
- [Licencia de esa implementación](https://github.com/lucidrains/BS-RoFormer/blob/main/LICENSE)
- [KUIELab MDX-Net y su arquitectura](https://github.com/kuielab/mdx-net)

Se conserva FP32 en este hardware. GPU, precisión reducida, ONNX y compilación del grafo requieren pruebas del dispositivo, de operadores y de calidad antes de su activación. Reentrenar para distinguir mejor guitarras, platillos o piano requiere datos y recursos de entrenamiento específicos.

## G. Archivos del cambio

| Archivo | Motivo |
| --- | --- |
| `backend/separation/inference.py` | Normalización, carga secuencial, ejecución, restauración de DC, ganancia y trazabilidad. |
| `backend/separation/runner.py` | Validación de caché y conexión del comando existente con el motor. |
| `server.mjs` | Registro de los parámetros efectivos en los metadatos de separación. |
| `scripts/benchmark-separation.py` | Comparación reproducible con tiempos, memoria, hashes y métricas. |
| `scripts/inference-regression.py` | Comprobaciones específicas de los errores corregidos y equivalencia de planificación. |
| `scripts/app-separation-smoke.mjs` | Validación del informe real desde la API usada por la web. |
| `scripts/quality-api-smoke.mjs` | Expectativa actualizada de los shifts del perfil máximo de Fine-Tuned. |
| `scripts/quality-guard-smoke.mjs` | Manejo de cambios de RAM entre consulta y admisión del trabajo de control. |
| `benchmarks/separation-2026-11-18.json` | Evidencias numéricas de las ejecuciones. |
| `docs/SEPARATION_OPTIMIZATION.md` | Análisis, decisiones, pruebas y límites. |
| `README.md`, `DEVELOPMENT_STATUS.md` | Enlace a la evaluación actual y a sus mediciones. |

## Reproducción

Preparar las cuatro referencias WAV oficiales como `drums.wav`, `bass.wav`, `other.wav`, `vocals.wav` en `data/temp/separation-benchmark/references`. Para Falcon, guardar las referencias de `audio/Reference/song_1/` de la página oficial en `falcon-references`, decodificar con FFmpeg de 5 a 17 segundos, a 44,1 kHz estéreo float, y sumar los WAV para obtener `falcon.wav`. Los hashes de los inputs del informe permiten comprobar las condiciones de reproducción.

```powershell
.venv/Scripts/python.exe scripts/benchmark-separation.py --prepare
.venv/Scripts/python.exe scripts/benchmark-separation.py --label comparison --repeat 3
.venv/Scripts/python.exe scripts/benchmark-separation.py --label comparison-ft --model htdemucs_ft
.venv/Scripts/python.exe scripts/benchmark-separation.py --label comparison-tta --model htdemucs_ft --shifts 2 --overlap 0.5
.venv/Scripts/python.exe scripts/benchmark-separation.py --label comparison-falcon --case falcon
.venv/Scripts/python.exe scripts/inference-regression.py
node scripts/app-separation-smoke.mjs
```

El benchmark admite `--runner` para ejecutar la copia original. Las referencias musicales se descargan explícitamente desde las fuentes citadas y se mantienen en el directorio de datos local.
