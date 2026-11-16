# Reporte de trabajo — 14 de noviembre de 2026

## Alcance y estado

Este informe recoge el trabajo realizado hoy en el fork local de FreeFrame y la revisión autorizada de su despliegue en Dokploy. Los cambios de código permanecen **locales y sin commit**: no se hizo push ni despliegue. No se modificaron la base de datos ni el almacenamiento de producción, ni el código de Ingest o Electron. No se incluyen credenciales.

## Ajustes del fork

Se trasladaron al código ajustes que antes se aplicaban mediante parches al iniciar los contenedores:

- **Enlaces compartidos:** el límite de validación pasó a 600 solicitudes por minuto por IP en `apps/api/routers/share.py`. Un límite mayor también permite más intentos de fuerza bruta; su aplicación por IP depende de la configuración del proxy.
- **Calidades de video:** la escalera predeterminada pasó a 720p y 360p en `apps/api/config.py` y `.env.example`. La variable `TRANSCODER_QUALITIES` sigue permitiendo cambiarla; los valores ya configurados en el entorno prevalecen.
- **FFmpeg:** el preset de CPU pasó a `veryfast` en `packages/transcoder/ffmpeg_transcoder.py`. Puede cambiar la eficiencia de compresión y el resultado visual.
- **Trabajos de transcodificación:** `apps/api/tasks/transcode_tasks.py` evita iniciar procesamiento para una versión o un asset ya eliminados. La comprobación es al inicio: no cubre una eliminación mientras el trabajo ya se está ejecutando.

Se actualizaron las pruebas correspondientes y `CHANGELOG.md`.

## Revisión de registros y Dokploy

Se analizaron los registros aportados de API, Redis y mantenimiento. El informe separado está en `~/.local/share/opencode/research/2026-11-14-logs-freeframe-redis-mantenimiento.md`.

- Se observó una ráfaga de tareas de mantenimiento distintas. No se pudo determinar si procedía de tareas acumuladas, varios productores, varios schedulers u otra causa.
- Los registros históricos mostraron una retención de un día; las ejecuciones de purga examinadas reportaron cero eliminaciones, lo que no demuestra que nunca se haya eliminado nada en otros momentos.
- Se observaron desconexiones de PostgreSQL, un aviso de Redis sobre overcommit, un error de permisos del socket de control de Gunicorn y un `AccessDenied` al intentar configurar CORS del bucket. No se estableció una causa común ni se verificó el CORS efectivo.
- Se inspeccionó Dokploy en modo lectura, con autorización. El worker de FreeFrame aparecía reiniciándose por un parche de arranque que busca la antigua lista de calidades. API, web, Redis, maintenance y Beat aparecían en ejecución en esa consulta.
- En el entorno general consultado figuraban `SOFT_DELETE_RETENTION_DAYS=1`, `ORPHAN_SWEEP_GRACE_HOURS=0` y `ORPHAN_SWEEP_DELETE=false`. Es necesario confirmar los valores efectivos y posibles sobrescrituras por servicio antes de actualizar.
- La aplicación Ingest separada compartía la configuración general de base de datos y bucket con FreeFrame; sus registros recientes mostraban ingestas completadas. No se confirmó que su código desplegado sea idéntico a la copia local examinada.

No se limpiaron colas, no se ejecutaron purgas manuales ni se alteraron ajustes del host o de Dokploy.

## Correcciones locales adicionales

- `apps/api/database.py`: se activó `pool_pre_ping` para detectar conexiones obsoletas antes de reutilizarlas. No recupera una transacción interrumpida durante su ejecución.
- `apps/api/Dockerfile.prod`: se crea y asigna a `appuser` un directorio home escribible para el socket de control de Gunicorn. No se construyó ni verificó la imagen resultante.
- `docs/deployment.md`: se documentaron la revisión necesaria de parches de arranque en Dokploy, la retención efectiva y las precauciones de actualización.

## Compatibilidad con Ingest

Se identificó que la copia local de Ingest registra el master HLS como `processed/{proyecto}/{asset}/{versión}/master.m3u8`, incluso antes de completar la carga. FreeFrame no reconocía esa ruta como propietaria del árbol HLS completo durante el barrido de huérfanos.

En `apps/api/tasks/cleanup_tasks.py` se hicieron dos cambios locales:

1. El barrido de huérfanos conserva los objetos bajo el directorio de la versión cuando existe ese master registrado, incluidos playlists y segmentos, aun si `s3_key_processed` todavía no está informado.
2. El reaper de cargas antiguas deja a Ingest las versiones identificadas por ese formato de master, en lugar de eliminarlas o marcarlas como borradas.

Se añadieron pruebas en `apps/api/tests/test_orphan_sweep.py` y `apps/api/tests/test_reap_stale_uploads.py`. Esto no cambia las purgas de retención ni la limpieza propia de Ingest, y no demuestra compatibilidad con cualquier variante de su código desplegado. Para aplicar la protección será necesario desplegar el cambio y recrear el worker de mantenimiento, previa revisión y autorización. Mantener desactivado el borrado de huérfanos hasta verificar el formato de Ingest desplegado.

## Verificaciones realizadas

- Pasaron **107 pruebas específicas** en una ejecución anterior de los ajustes del fork y **102 pruebas específicas** en otra ejecución de las correcciones posteriores; son ejecuciones diferentes y pueden solaparse.
- Para la compatibilidad de limpieza con Ingest pasaron **33 pruebas** de `test_orphan_sweep.py`, `test_reap_stale_uploads.py` y `test_reaper_multipart_sweep.py`, con la base de prueba previamente verificada y operaciones S3 simuladas en esas pruebas.
- `git diff --check` pasó tras los cambios.
- No se completó la suite integral del backend en esta jornada; tampoco se verificaron build, pruebas, TypeScript o lint del frontend por falta de dependencias locales. ShellCheck y Bats no estaban instalados. No se verificó la imagen Docker de producción.

## Pendientes y decisiones

1. Investigar el origen de la ráfaga de tareas, el estado de Beat y las colas sin eliminar trabajo legítimo.
2. Verificar backups, retención efectiva, CORS del bucket y configuración del proxy; correlacionar las desconexiones con PostgreSQL y red.
3. Antes de desplegar, revisar el Compose completo y retirar o adaptar los parches Python de inicio que ya no coinciden con el código; conservar configuración y datos existentes. No se autorizó un despliegue.
4. Se conversó sobre retirar el procesamiento de video en la nube y usar Ingest desde escritorio. **No se implementó**: las cargas de video desde la web dependen actualmente de ese procesamiento, y falta decidir si se deben bloquear con un mensaje y cómo tratar los trabajos pendientes. Audio, imágenes y otras tareas necesitan una evaluación separada.
5. Revisar el token de enlace compartido que apareció en registros proporcionados previamente y considerar su revocación o regeneración.
