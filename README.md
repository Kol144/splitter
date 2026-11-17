# AI Music Separator Studio

Aplicación local para separar audio en stems con modelos reales de IA. El servidor escucha solo en `127.0.0.1`; los originales, resultados y la biblioteca SQLite quedan dentro de `data/`.

## Inicio

1. Instala Node.js 22.13 o posterior.
2. Ejecuta `INSTALL.bat`. Prepara Python 3.11, PyTorch CPU y Demucs; no descarga pesos de modelos.
3. Ejecuta `START.bat`.
4. En `AI Models`, elige HTDemucs para uso diario o HTDemucs Fine-Tuned para priorizar calidad. Fine-Tuned exige al menos 3 GB de RAM libre y puede tardar aproximadamente cuatro veces más.
5. Importa un audio y pulsa **Separar**.

FFmpeg/ffprobe se recomiendan para el análisis técnico. FFmpeg es necesario para extraer audio de vídeo y convertir las copias exportadas. La descarga WAV original funciona sin conversión. Consulta [INSTALLATION_GUIDE.md](INSTALLATION_GUIDE.md).

## Estado de esta versión

La interfaz y el servidor local están implementados. La integración invoca Demucs v4 en CPU y solo acepta un trabajo simultáneo. HTDemucs produce vocals, drums, bass y other; HTDemucs 6S es experimental y añade guitar/piano, con resultados de piano limitados según el propio proyecto. Consulta [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md) para ver qué está probado en este entorno.

El catálogo incluye `htdemucs`, `htdemucs_ft`, `mdx_extra`, `mdx_extra_q` y `htdemucs_6s`. Los dos primeros están instalados y se han ejecutado en este equipo. MDX-Extra sin cuantizar ofrece una alternativa sin DiffQ, pero requiere una descarga y más memoria. El servidor comprueba RAM y espacio antes de procesar, y guarda los parámetros realmente utilizados en el proyecto.

| Perfil | Parámetros de inferencia | Salida |
| --- | --- | --- |
| Rendimiento | shifts 0, overlap 0.1 | WAV PCM 16-bit |
| Equilibrado | shifts 0, overlap 0.25 | WAV PCM 24-bit |
| Máxima calidad | overlap 0.5; shifts 2 en modelos simples, 0 en ensembles | WAV 32-bit float |

Fine-Tuned ya combina cuatro modelos, por lo que no se multiplican sus pasadas otra vez. La profundidad de salida conserva precisión; por sí sola no mejora la separación de fuentes. Los mínimos de RAM libre son 1.2 GB para HTDemucs (1.6 GB en máximo), 3 GB para Fine-Tuned, 3.5 GB para MDX-Extra y 2 GB para MDX-Extra-Q/6S. Son controles preventivos, no garantías para canciones de cualquier duración.

## Escuchar y revisar los stems

Cada pista tiene un Play junto al nombre para escucharla individualmente, sin cambiar las selecciones Solo. Play vuelve a pausar la escucha individual. **Escuchar mezcla** vuelve a las pistas sincronizadas respetando Solo/Mute; puedes activar Solo en varias pistas. Mute tiene prioridad y deja la pista gris, igual que las pistas excluidas de Solo. Las animaciones de entrada y reproducción respetan la preferencia de reducir movimiento. El diseño se adapta a pantallas estrechas; el motor sigue ejecutándose en el PC y el servidor continúa restringido a loopback.

**Revisar silencios** analiza pistas ya separadas sin volver a cargar Demucs. También se puede seleccionar la limpieza antes de una separación nueva:

- **Conservar todo:** comportamiento inicial, sin cambios de audio.
- **Solo silencio casi digital:** tramos de al menos 250 ms por debajo de un paso de cuantización de la salida (o 1e-7 para float32).
- **Residuo muy débil, experimental:** tramos largos, de bajo nivel y espectro similar a ruido. Requiere RMS ≤ −72 dBFS, pico ≤ −58 dBFS, ausencia de contenido tonal según planitud espectral y al menos 1.2 s continuos. Protege 200 ms en los bordes y aplica fundidos de 20 ms.

El análisis usa bloques pequeños y protege ambos canales. Es un criterio acústico conservador; no puede saber con certeza si un ambiente tenue tiene valor musical. Conserva siempre el stem original, la duración y la sincronización. Si encuentra candidatos, el selector **Original de Demucs / Versión revisada** permite comparar y escoger también qué versión exportar individualmente o en ZIP. Si no encuentra candidatos, no altera el stem. El informe de intervalos queda en los metadatos y en `refinement-report.json` dentro del directorio de trabajo.

Los stems pueden exportarse individualmente o juntos en ZIP como WAV, FLAC, MP3, AAC/M4A, OGG o AIFF. Para las copias se pueden elegir frecuencia de muestreo, profundidad de bits, mono/estéreo y normalización cuando el formato lo admite. La app genera una forma de onda leyendo los WAV reales mediante Web Audio API. No genera stems de muestra ni resultados de demostración. Los formatos se comprobaron con archivos de control; queda validar las exportaciones desde una canción real separada con HTDemucs.

## Requisitos de software

- Windows 10/11 x64.
- Node.js 22.13+.
- Python 3.11 x64 para la configuración fijada.
- PyTorch 2.5.1 CPU, torchaudio 2.5.1 CPU y Demucs 4.0.1. DiffQ 0.2.4 para MDX-Extra-Q requiere Microsoft C++ Build Tools en Windows.
- FFmpeg/ffprobe para vídeo y metadatos técnicos.
- Descarga de pesos del modelo desde el repositorio oficial en el primer uso.

No se cargan modelos pesados automáticamente. Usa AI Models para consultar el tamaño antes de descargar. Una vez instalados los pesos, la inferencia funciona sin conexión.

## Documentación

- [Guía de instalación](INSTALLATION_GUIDE.md)
- [Solución de problemas](TROUBLESHOOTING.md)
- [Estado de desarrollo](DEVELOPMENT_STATUS.md)

## Pruebas de desarrollo

Con el servidor iniciado: `npm run smoke`, `npm run test:cancel`, `npm run test:quality-guard`, `npm run test:engine-api` y `npm run test:residue`.

Para probar la reproducción real en navegador, instala las dependencias de desarrollo con `npm ci` y el navegador de pruebas con `npx playwright install chromium --only-shell`; después ejecuta `npm run test:mixer`. Este test usa audio sintético autorizado, crea su propio proyecto y lo elimina al terminar. Comprueba Play, dos Solo, Mute, los nodos de volumen reales, sincronización, exportación de variantes y diseño a 390 px. Las señales de control validan el funcionamiento técnico, no una calidad musical universal.

## Fuentes del motor

La implementación usa el [repositorio Demucs de Meta](https://github.com/facebookresearch/demucs), su [guía para Windows](https://github.com/facebookresearch/demucs/blob/main/docs/windows.md) y el [catálogo oficial de pesos](https://github.com/facebookresearch/demucs/blob/main/demucs/remote/files.txt). El código de Demucs se publica con licencia MIT. El repositorio fue archivado el 1 de enero de 2025, así que futuras actualizaciones requieren una comprobación de compatibilidad. El README upstream describe la salida de cuatro fuentes, el modelo 6S experimental, el uso CPU y sus limitaciones de calidad para piano.

DiffQ se publica con licencia CC-BY-NC 4.0; comprueba sus condiciones si eliges MDX-Extra-Q. FFmpeg no se redistribuye con este proyecto. Git ignora `data/`, el entorno Python, los pesos, los resultados de pruebas y los archivos de entorno: las canciones no se incluyen al subir el código a GitHub.

## Seguridad y privacidad

- El servidor solo se enlaza a loopback (`127.0.0.1`).
- No hay cuentas, telemetría, cargas remotas ni llamadas de analítica.
- Las descargas de dependencias ocurren durante `INSTALL.bat`; la descarga de pesos ocurre únicamente al pulsar **Install**.
- FFmpeg se instala aparte. Algunos builds completos, como el distribuido por Gyan, están bajo GPL-3.0; la aplicación no incluye ni redistribuye FFmpeg.
- La función Smart Stem Recovery no está implementada y no se consulta ningún catálogo externo de canciones.
