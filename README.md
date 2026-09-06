# Papers CHVN

Registro privado de producción académica con HTML, CSS, JavaScript, Node.js y PostgreSQL.

## Uso local

La aplicación desplegada guarda los registros en PostgreSQL y conserva una copia local de respaldo. Usa **Exportar** con regularidad para crear respaldos JSON e **Importar** para restaurarlos.

## Próxima etapa

Configura `DATABASE_URL`, `APP_PASSWORD` y `SESSION_SECRET` como variables privadas del servicio.

## Railway

El proyecto incluye un servidor Node.js sin dependencias externas y la configuración necesaria para desplegarse directamente en Railway.

## Abrir carpetas de proyectos en macOS

La aplicación usa el protocolo local `papers-chvn://` para abrir en Finder las carpetas asociadas a los papers en proceso. El asistente se instala una sola vez ejecutando `mac-helper/install.command`; queda guardado en `~/Applications/Papers CHVN Folder Opener.app` y solo permite abrir rutas dentro de `/Users/cesarvalencia`.
