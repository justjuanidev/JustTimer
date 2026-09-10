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
- `justtimer.tasks.v1`: tareas de la sesión activa o pendientes para la siguiente sesión.
- `justtimer.dayTasks.v1`: tareas generales y del día.
- `justtimer.dailyPriorities.v1`: plan histórico por fecha. Cada entrada referencia una tarea real de `dayTasks`, conserva su slot principal/adicional y una copia del texto para la revisión histórica. No se deriva de la fecha límite.
- `justtimer.projects.v1`: proyectos.
- `justtimer.projectChannels.v1`: secciones visuales para organizar videos.
- `justtimer.workChannels.v1`: canales de trabajo personalizables, nombre y foto de perfil.
- `justtimer.workArea.v1`: canal predeterminado para nuevas sesiones (`JustJuani` o `Laburo`).
- `justtimer.habits.v1` y claves relacionadas: hábitos y registros.
- `justtimer.miniProjects.v1` y `justtimer.miniProjectSessions.v1`: mini-proyectos opcionales, emoji personalizable, mínimo recomendado, notas de continuidad y tiempo acumulado. Su panel resume sesiones y tiempo total, semanal, mensual y anual desde el historial real.
- `justtimer.miniProjectContext.v1`: próxima sesión usada para limitar el timer a un minuto antes de su inicio.
- `justtimer.sessionTypes.v1`: tipos de sesión.
- `justtimer.activeSession.v1`: recuperación de la sesión en curso.
- Las demás claves `justtimer.*`: preferencias de interfaz y configuración.

Las estadísticas no se guardan por separado: se calculan desde
`justtimer.sessions.v1`, por lo que el historial de sesiones es su fuente de verdad.
Cada sesión conserva además `workArea` y, opcionalmente, `projectId`: sin video se
contabiliza como trabajo general del canal; con video suma a ese video y a su canal.
Las tareas planificadas se guardan dentro de la sesión futura y se copian a
`justtimer.tasks.v1` cuando esa sesión comienza.

Las tareas importadas desde un video conservan `projectTaskId`. Cada sesión guarda
su propio `focusedSecs`; la tarea original acumula esos aportes en `sessionFocus`,
expone `sessionIds`/`sessionCount` y se completa automáticamente cuando se marca
desde el timer. La primera tarea pendiente recibe el tiempo por defecto. Cambiarla
o reordenar la lista solo cambia la atribución del tiempo: el reloj de la sesión
continúa corriendo. Al cerrar una sesión, los pendientes pueden copiarse a la
próxima sesión o permanecer en `justtimer.tasks.v1`.

- `justtimer.channelGoals.v1`: objetivos editables de minutos diarios y semanales
  por canal. El canal interno `routine` se muestra como “Personal”, usa una J como
  avatar y participa en calendario/estadísticas, pero se oculta de la biblioteca
  de Videos.
- `justtimer.weeklyPlans.v1`: plan histórico indexado por el lunes de cada semana.
  Guarda solamente la configuración elegida (objetivo global de sesiones, ritmo
  diario orientativo, días previstos, enfoque, foco principal y objetivos diarios
  y semanales por canal). Si un plan anterior no tiene objetivo diario por canal,
  se deriva proporcionalmente del objetivo diario y semanal general. Las sesiones,
  minutos, energía y resultados siguen calculándose desde
  `justtimer.sessions.v1`. Las ediciones de una semana iniciada conservan hasta 20
  configuraciones anteriores dentro de `revisions`.

El calendario incluye una lista lateral de tareas pendientes de los videos. Al
asignar una tarea a una sesión conserva el mismo `projectTaskId`, por lo que su
estado, cantidad de sesiones y tiempo acumulado continúan sincronizados con el
video original.

Cada proyecto puede guardar `startDate`, `dueDate` y `autoStartOnPlanning`. Las
fechas se muestran como hitos de día completo en el calendario semanal. Cuando
`autoStartOnPlanning` está activo, el primer cambio al estado `planning` asigna la
fecha actual como inicio sin reemplazar una fecha establecida manualmente.

Los hábitos admiten varios `reminderTimes`, horarios sugeridos por mañana, tarde y
noche, `remindOnAppStart` y `remindOnPhaseStart`. Estos disparadores reutilizan el
mismo registro diario y dejan de avisar al completar o justificar el hábito.

Las subtareas se guardan como tareas normales con `parentTaskId`, por lo que cada
una puede acumular tiempo, completarse y asignarse a sesiones de manera
independiente. Durante una sesión también pueden crearse desde la tarea madre:
se vinculan al proyecto original, aparecen anidadas en el timer y pueden elegirse
como tarea activa para contabilizar su propio tiempo. Las secciones de proyectos guardan `orientation` (`horizontal` o
`vertical`) y los proyectos pueden cambiar de canal conservando sus tareas y el
historial de sesiones asociado.

Las tareas de proyecto pueden guardar `order` y `estimatedSessions`. El orden se
modifica arrastrando y la estimación es orientativa: el progreso real continúa
derivándose de los `sessionIds` vinculados y puede superar el valor estimado.
También pueden guardar `activateDate`, `activateToCategory` y una lista
`blockedByTaskIds`. Una tarea en Snooze o Incubadora se activa cuando se cumple la
fecha y, si tiene dependencias, cuando todas están completadas. Los movimientos
automáticos conservan un historial breve en `activationHistory`; no crean tareas
ni estadísticas duplicadas.

Las prioridades del día nunca duplican la tarea: `taskId`/`sourceDayTaskId` apunta
al registro original. Los tres slots principales no se rellenan automáticamente al
completar una tarea; las prioridades adicionales solo se crean por acción explícita.

La pantalla inicial crea únicamente sesiones del canal interno `routine`. El
calendario funciona como vista semanal y planificador: la creación manual y el
registro retroactivo ya no forman parte de su interfaz. Los detalles históricos
de cada sesión se muestran en un diálogo independiente para que no modifiquen el
ancho del calendario.

## Compatibilidad futura

Los snapshots tienen `schemaVersion` y `appVersion`. Antes de ejecutar por primera
vez una versión nueva, JustTimer crea un backup de los datos persistentes. Las
migraciones futuras deben ser aditivas, aumentar `schemaVersion`, generar el backup
antes de transformar datos y conservar las claves anteriores hasta verificar la
nueva estructura.
