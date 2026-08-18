# JustTimer: almacenamiento y actualizaciones seguras

## Ubicaciones

- Código instalado: `%LOCALAPPDATA%\Programs\JustTimer` (reemplazable al actualizar).
- Datos persistentes: `%APPDATA%\JustTimerData\User Data` (nunca es destino del instalador).
- Snapshots JSON: `%APPDATA%\JustTimerData\Snapshots\current.json`.
- Backups automáticos: `%APPDATA%\JustTimerData\Backups`.

Las versiones anteriores guardaban los datos en `%APPDATA%\justtimer`. La primera
ejecución de esta versión crea un backup completo y copia esos datos a la ubicación
estable. Nunca borra ni reemplaza la carpeta anterior.

## Datos funcionales

El almacenamiento local conserva las claves versionadas siguientes:

- `justtimer.sessions.v1`: sesiones e información usada para calcular estadísticas.
- `justtimer.tasks.v1`: tareas de la sesión activa.
- `justtimer.dayTasks.v1`: tareas generales y del día.
- `justtimer.dailyPriorities.v1`: prioridades obligatorias, separadas por fecha local.
- `justtimer.projects.v1`: proyectos.
- `justtimer.habits.v1` y claves relacionadas: hábitos y registros.
- `justtimer.sessionTypes.v1`: tipos de sesión.
- `justtimer.activeSession.v1`: recuperación de la sesión en curso.
- Las demás claves `justtimer.*`: preferencias de interfaz y configuración.

Las estadísticas no se guardan por separado: se calculan desde
`justtimer.sessions.v1`, por lo que el historial de sesiones es su fuente de verdad.

## Compatibilidad futura

Los snapshots tienen `schemaVersion` y `appVersion`. Antes de ejecutar por primera
vez una versión nueva, JustTimer crea un backup de los datos persistentes. Las
migraciones futuras deben ser aditivas, aumentar `schemaVersion`, generar el backup
antes de transformar datos y conservar las claves anteriores hasta verificar la
nueva estructura.
