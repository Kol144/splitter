# Solución de problemas

## `Python no está instalado` o `Falta PyTorch CPU o Demucs`

Ejecuta `INSTALL.bat`. Comprueba que termine sin errores y que `.venv\Scripts\python.exe` exista. Si configuraste otro Python, define `AIMS_PYTHON` con la ruta completa a su ejecutable.

## Descarga de PyTorch fallida

Comprueba la conexión, el espacio libre y que ningún antivirus corporativo bloquee PyPI o `download.pytorch.org`. Vuelve a ejecutar `INSTALL.bat`; pip puede reutilizar los archivos descargados. El instalador no descarga pesos de modelos.

## MDX-Extra-Q requiere DiffQ

HTDemucs no necesita DiffQ. MDX-Extra-Q sí: en Windows, `diffq` compila una extensión nativa y requiere Microsoft C++ Build Tools (MSVC 14.0 o superior). Instala el workload de herramientas C++ y luego ejecuta `.venv\Scripts\python.exe -m pip install diffq==0.2.4`. Actualiza AI Models para volver a detectar la dependencia. Si falta, la app mantiene MDX-Extra-Q bloqueado y HTDemucs sigue disponible.

## `No se pudo comprobar el tamaño` del modelo

El comprobador envía una solicitud HEAD a los archivos que declara el catálogo de Demucs. Comprueba que el equipo pueda llegar a `dl.fbaipublicfiles.com` y que Python/Demucs esté listo. No se habilita la descarga hasta que el usuario confirme en el cuadro del modelo.

## Fallo al instalar los pesos

Revisa el mensaje del panel AI Models, la conexión y el espacio libre. Se requiere memoria libre antes de iniciar. Puedes cancelar la descarga; los archivos parciales no cuentan como modelo instalado y se reemplazan al volver a instalar.

## FFmpeg/ffprobe no detectados

Instala ambos ejecutables y confirma que están en el `PATH` de Windows. Cierra todos los procesos de la app, vuelve a abrirla y comprueba Configuración. El audio puede importarse sin FFmpeg, pero algunos formatos no serán analizables; vídeo requiere FFmpeg.

## Separación bloqueada por memoria

Cierra otras aplicaciones. El servidor comprueba la RAM disponible antes de cargar el modelo y permite un solo trabajo. Esta comprobación es preventiva, no una garantía de que una canción larga vaya a caber en cualquier momento.

Fine-Tuned requiere 3 GB libres y MDX-Extra 3.5 GB. HTDemucs normal necesita menos. La app no cambia automáticamente el modelo ni reduce la calidad seleccionada. Durante `Cancelando`, espera a que Python cierre antes de iniciar otro trabajo.

## La revisión elimina un sonido que quería conservar

Selecciona **Original de Demucs** encima de las pistas: tanto la reproducción como las descargas usarán la salida intacta. El modo de residuos solo debe elegirse tras comparar; el análisis acústico no conoce el valor artístico de un sonido tenue. También puedes volver a revisar con **Solo silencio casi digital**, que siempre parte del original.

## No suenan todas las pistas

El Play de cada fila activa escucha individual. **Escuchar mezcla** vuelve a la mezcla sincronizada. Comprueba S, M, el volumen de pista y el general: Mute tiene prioridad sobre Solo. Varias pistas pueden estar en Solo al mismo tiempo; las demás se muestran grises.

## La forma de onda no aparece

El navegador decodifica cada stem WAV real para dibujar su forma de onda. Comprueba que el WAV esté presente y que el navegador tenga suficiente memoria. Una forma de onda fallida no genera un gráfico de sustitución.

## El servidor ya está en ejecución o el puerto 4173 está ocupado

Ejecuta `STOP.bat`. Si la app no estaba ejecutándose, comprueba qué proceso escucha en 4173 antes de iniciar otra instancia; no cambies el puerto en una sesión existente sin reiniciarla.

## Modelo 6S

La guitarra y piano son fuentes experimentales. HTDemucs upstream advierte que el piano tiene bastante contaminación y artefactos. Usa HTDemucs para vocals, drums, bass y other.

## Datos del proyecto

Los archivos permanecen en `data/projects/`. Eliminar una tarjeta de proyecto borra su carpeta y stems locales. No edites `data/library.sqlite` mientras la app esté abierta.
