# Guía de instalación

## 1. Instalar dependencias

En Windows 10/11 de 64 bits, instala Node.js 22.13 o posterior. Ejecuta `INSTALL.bat`. Si Python 3.11 no está instalado, el instalador ofrece añadirlo para el usuario actual mediante winget; también puedes instalarlo manualmente desde [Python para Windows](https://www.python.org/downloads/windows/).

El instalador crea `.venv` en esta carpeta e instala el wheel CPU de PyTorch/torchaudio 2.5.1, Demucs 4.0.1 y, si se puede compilar, DiffQ 0.2.4 (requerido por MDX-Extra-Q). En Windows, DiffQ necesita Microsoft C++ Build Tools para compilar su extensión. Si no está disponible, HTDemucs seguirá funcionando y AI Models mostrará MDX-Extra-Q como incompatible hasta instalar DiffQ. La distribución PyTorch es CPU-only; no configura CUDA ni XPU. El instalador imprime la capacidad CPU que PyTorch detecta.

La instalación necesita Internet y alrededor de 2 GB libres para el entorno Python/PyTorch; el consumo exacto varía por versión. Los pesos de separación no se descargan en este paso.

## 2. Instalar FFmpeg (necesario para vídeo y conversiones de exportación)

Instala un build de FFmpeg para Windows siguiendo la página del proyecto [FFmpeg Downloads](https://ffmpeg.org/download.html), y añade `ffmpeg.exe` y `ffprobe.exe` al `PATH`. Por ejemplo, `winget install --exact --id Gyan.FFmpeg --scope user` instala el build full de Gyan, publicado bajo GPL-3.0; la aplicación no lo redistribuye. Comprueba la licencia del build que elijas. Cierra y vuelve a abrir `START.bat` para que el servidor herede el PATH actualizado.

La app usa `ffprobe` para enumerar pistas de audio y metadatos; `ffmpeg` extrae la pista elegida de un vídeo y convierte copias exportadas a FLAC, MP3, AAC/M4A, OGG o AIFF, además de aplicar cambios de frecuencia, profundidad, canales y normalización. Una descarga WAV sin conversiones no necesita FFmpeg. No instala builds de FFmpeg automáticamente.

## 3. Iniciar y detener

- Ejecuta `START.bat`; inicia el servidor en segundo plano, consulta su estado y abre `http://127.0.0.1:4173`.
- Ejecuta `STOP.bat` para cerrar ese servidor mediante su endpoint local.
- Si el servidor no inicia, ejecuta `node server.mjs` en una consola para ver el error.

## 4. Instalar pesos de IA

1. Abre **AI Models**.
2. Pulsa **Install** junto al modelo.
3. La app solicita el tamaño de los archivos al repositorio oficial de Meta y muestra el total antes de pedir confirmación.
4. Al confirmar, Demucs descarga y valida los archivos en la caché local de PyTorch.

HTDemucs es la opción diaria. HTDemucs Fine-Tuned combina cuatro modelos afinados, puede mejorar la separación y tarda aproximadamente cuatro veces más; la app exige 3 GB libres antes de cargarlo. MDX-Extra funciona sin DiffQ y exige 3.5 GB libres. MDX-Extra-Q necesita DiffQ (licencia CC-BY-NC 4.0). HTDemucs 6S es experimental. La app no activa descargas al importar una canción.

## 5. Ejecutar una separación

1. Importa un archivo.
2. Elige Quick split para los cuatro grupos estándar o Advanced split para guardar solo fuentes disponibles en el modelo elegido.
3. Selecciona un perfil. Balanced usa shifts 0, overlap 0.25 y WAV 24-bit; los hilos se eligen en Configuración (cuatro por defecto). Máxima calidad guarda float32, aumenta el solapamiento y añade dos shifts solo en modelos que no son ensembles.
4. Pulsa **Separar**.
5. Elige el formato y los parámetros de exportación; descarga un stem o todos en ZIP. Los cambios se aplican a copias y conservan los stems WAV originales.

El panel AI Models indica la compatibilidad del modelo instalado. La guitarra/piano aparecen solo para HTDemucs 6S; esto no significa que la separación sea limpia.

Play junto a cada nombre escucha solo esa pista. S permite combinar varias pistas en Solo; M silencia y deja la pista gris. **Revisar silencios** puede ejecutarse después de separar, sin cargar otra vez el modelo. Conserva el original de Demucs y ofrece un selector para comparar y exportar la versión elegida. Los detalles y límites del análisis están en el README.

## 6. Directorios locales

- `data/library.sqlite`: metadatos de proyectos y trabajos.
- `data/projects/<id>/`: original, audio extraído y stems.
- `data/temp/`: archivos temporales.
- `data/exports/`: ZIP temporal durante la descarga.
- `.venv/`: entorno Python de la aplicación.

Los proyectos no se eliminan al actualizar o reiniciar la aplicación. El botón de borrar proyecto sí elimina el directorio de ese proyecto. Usa **Limpiar temporales** para vaciar únicamente `data/temp/`.
