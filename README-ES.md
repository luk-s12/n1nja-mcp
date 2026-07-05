<div align="center">

<img src="img/n1nja-logo.png" alt="N1nja Logo" width="700"/>

**El servidor MCP que caza queries N+1 de Hibernate/JPA en aplicaciones Spring Boot — silencioso, preciso y rápido.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blueviolet?style=flat-square)](https://modelcontextprotocol.io/)
[![Spring Boot](https://img.shields.io/badge/Spring_Boot-3.x-6DB33F?style=flat-square&logo=springboot&logoColor=white)](https://spring.io/projects/spring-boot)
[![License](https://img.shields.io/badge/Licencia-MIT-yellow?style=flat-square)](LICENSE)
[![CI](https://github.com/luk-s12/n1nja-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/luk-s12/n1nja-mcp/actions/workflows/ci.yml)

---

🌐 **[Read in English](README.md)**

</div>

---

## ✨ Qué hace

Este servidor MCP se conecta a Claude Code (o Claude Desktop) y le da la capacidad de **leer tus logs de Hibernate, detectar anti-patrones de performance, y encontrar la línea de código exacta que los causa** — sin que tengas que buscar manualmente entre miles de líneas de log.

| Sin esta herramienta | Con esta herramienta |
|---|---|
| Grep en 50k líneas de logs | `analyze_hibernate_log({ "logFile": "app.log" })` |
| Contar queries repetidas a mano | Detección automática de N+1 con evidencia |
| Adivinar qué entidad es el problema | Clase, campo y método exacto identificado |
| Leer la doc de Hibernate para el fix | Sugerencias de fix rankeadas con ejemplos de código |

---

## 🚀 Inicio rápido

> **Requisitos:** Node.js ≥ 18, npm ≥ 8

### 1. Instalá N1nja

El script instalador maneja las dependencias, la compilación, la config de Claude Desktop y la selección de idioma automáticamente:

```bash
git clone https://github.com/luk-s12/n1nja-mcp
cd n1nja-mcp
node install.js
```

> Para desinstalar más adelante, corré `node uninstall.js` desde la carpeta del proyecto.

### 2. Configurá el logging de Hibernate

El MCP lee un archivo de log de Hibernate, así que tu app Spring Boot tiene que generarlo. Mirá la sección **⚙️ Configuración** (acá abajo) para habilitarlo — y después estás listo para tu primer escaneo.

---

## ⚙️ Configuración

### Logging de Spring Boot

> 💡 **¿Preferís saltarte la configuración manual?** Corré la herramienta [`autoconfig`](#autoconfig) una vez — detecta si tu proyecto usa Logback o properties simples y te deja armado todo lo de abajo. El resto de esta sección explica qué configura (y cómo hacerlo a mano).

Agregá esto a tu `application.yml` — es lo que alimenta al MCP:

```yaml
spring:
  jpa:
    show-sql: true
    properties:
      hibernate:
        format_sql: true
        generate_statistics: true

logging:
  file:
    name: logs/application.log        # El MCP lee este archivo
  level:
    org.hibernate.SQL: DEBUG          # Captura todo el SQL
    org.hibernate.orm.jdbc.bind: TRACE # Captura los parámetros bind
    org.hibernate.stat: DEBUG         # Captura las estadísticas
```

> **Tip:** Nunca habilitás `TRACE` en producción. Usá un perfil de Spring dedicado (`dev`, `local`) para esto.

> **¿No querés tocar el `pattern` de logs?** No hace falta. N1nja entiende el **formato por defecto de Spring Boot** (`<timestamp>  NIVEL <PID> --- [thread] logger : mensaje`), así que con habilitar los niveles de arriba alcanza — no necesitás definir un `logging.pattern` custom. Si igual usás un pattern propio con el thread justo después de la hora (`<timestamp> [thread] NIVEL ...`), también funciona.

#### Proyectos con un `logback-spring.xml` propio

> ⚠️ **Si tu proyecto ya trae su propio `logback-spring.xml` (o `logback.xml`), las properties `logging.file.name` y `logging.level` de arriba se ignoran.** Spring Boot le cede el control del logging a tu configuración de Logback, así que el archivo de log nunca aparece y `full_scan` reporta **0 queries**. En ese caso, configurá Logback directamente:

```xml
<configuration>

    <appender name="consoleAppender" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %logger : %msg%n</pattern>
        </encoder>
    </appender>

    <!-- Escribe el archivo que lee el MCP -->
    <appender name="fileAppender" class="ch.qos.logback.core.FileAppender">
        <file>logs/application.log</file>
        <encoder>
            <pattern>%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %logger : %msg%n</pattern>
        </encoder>
    </appender>

    <!-- Loggers de Hibernate que el MCP necesita -->
    <logger name="org.hibernate.SQL" level="DEBUG"/>
    <logger name="org.hibernate.orm.jdbc.bind" level="TRACE"/>
    <logger name="org.hibernate.stat" level="DEBUG"/>

    <root level="info">
        <appender-ref ref="consoleAppender"/>
        <appender-ref ref="fileAppender"/>
    </root>

</configuration>
```

> 📌 Si el proyecto ya usa un encoder/layout custom (ej. un `MaskingPatternLayout` para enmascarar PII), reutilizá ese mismo layout en el `fileAppender` en lugar del `pattern` genérico, para no filtrar datos sensibles al archivo.

**Notas (para ambos casos):**
- La carpeta `logs/` se crea automáticamente al arrancar la app, relativa al working directory donde corre el proceso.
- El log debe contener queries reales: hay que ejercitar los endpoints/flujos que disparen consultas **antes** de correr `full_scan`, o el reporte dará 0 queries.

### Umbrales de detección

Pasá un objeto `config` a `analyze_hibernate_log` para sobreescribir los valores por defecto:

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `nPlusOneThreshold` | `10` | Mínimo de ejecuciones en todo el log para detectar N+1 |
| `nPlusOnePerRequestThreshold` | `3` | Mínimo de ejecuciones con parámetros distintos en el mismo request/thread para detectar N+1 |
| `duplicateQueryThreshold` | `2` | Mínimo de ejecuciones para detectar DUPLICATE_QUERY |
| `largeResultThreshold` | `1000` | Umbral de filas para LARGE_RESULT_SET |
| `slowQueryMs` | `500` | Tiempo de ejecución en ms para SLOW_QUERY |
| `cartesianJoinThreshold` | `2` | Mínimo de JOINs para advertir producto cartesiano |

Podés sobreescribir solo los que te interesen — el resto mantiene su valor por defecto:

```json
{
  "logFile": "logs/application.log",
  "config": {
    "nPlusOneThreshold": 5,
    "slowQueryMs": 200
  }
}
```

O ajustar varios a la vez, para un modo más estricto:

```json
{
  "logFile": "logs/application.log",
  "config": {
    "nPlusOneThreshold": 3,
    "nPlusOnePerRequestThreshold": 2,
    "largeResultThreshold": 500,
    "slowQueryMs": 200
  }
}
```

Ese objeto es el argumento que recibe la herramienta. Desde tu cliente MCP lo invocás así:

```
> analyze_hibernate_log logFile: "logs/application.log" config: { "nPlusOneThreshold": 3, "slowQueryMs": 200 }
```

O, más natural, simplemente pedíselo a Claude y él arma el `config`:

```
> Analizá logs/application.log pero marcá N+1 a partir de 3 repeticiones y queries lentas sobre 200ms
```

> El mismo objeto `config` también se acepta en `full_scan`.

### Tu primer escaneo

Con el logging habilitado, reiniciá tu cliente MCP y ya estás listo:

```
> full_scan
```

---

## 🛠️ Herramientas MCP

> Todos los parámetros de todos los comandos son **opcionales** — cada uno tiene un valor por defecto razonable, así que podés llamar cualquier herramienta sin argumentos. En la tabla, **`def.`** indica ese valor por defecto.

| Comando | Tipo | Parámetros clave (todos opcionales) | Descripción |
|---------|------|-------------------------------------|-------------|
| `autoconfig` | Setup | `projectRoot` (def. cwd) | Auto-configura el logging que N1nja necesita. Detecta si hay un Logback propio y edita el XML, o agrega las properties a `application.properties`/`yml`. **Corré esto una vez, antes de `full_scan`.** |
| `full_scan` | ⭐ Todo-en-uno | `logFile` (def. `logs/application.log`), `projectRoot` (def. cwd), `outputFile`, `config` | Parsea el log + escanea el código + escribe un `.md` con fixes listos para copiar. **Empezá por acá.** |
| `analyze_hibernate_log` | Log | `logFile` (def. `logs/application.log`), `config` | Detecta N+1, queries duplicadas, resultados grandes, queries lentas, productos cartesianos, SELECT * y deadlocks. |
| `find_n1_in_code` | Análisis | `projectRoot` (def. cwd) | Escanea el código Java y encuentra la entidad, campo y método exacto que causa cada problema. |
| `find_missing_indexes` | Base de datos | `envFile`, `projectRoot` | Conecta a la DB, cruza columnas de WHERE/JOIN/ORDER BY con los índices existentes, genera sentencias `CREATE INDEX`. |
| `show_report` | Consulta | `format` (def. `json`) | Devuelve el último reporte sin re-parsear. Formatos: `json`, `markdown`, `both`, `pdf`. |
| `monitor_log` | Tiempo real | `action` (def. `start`), `logFile` (def. `logs/application.log`) | Hace tail del log en vivo. Acciones: `start`, `stop`, `status`. Usá `show_report` para ver los resultados. |
| `explain_sql` | Base de datos | `sql`, `maxQueriesToExplain` (def. 3), `envFile`, `projectRoot` | Ejecuta `EXPLAIN ANALYZE` y analiza el plan de ejecución. Credenciales desde `.env`, variables de entorno o el `application.properties` de Spring. |

---

### `autoconfig`

Configura el logging que N1nja necesita para capturar el SQL de Hibernate — así no tenés que editar ninguna config a mano. Detecta cómo está armado tu proyecto y hace lo correcto:

- **Logback propio** (`logback-spring.xml` / `logback.xml`): edita el XML — agrega un file appender que escribe `logs/application.log`, los loggers de Hibernate y el `appender-ref` en el `<root>`. (Cuando hay Logback, Spring Boot ignora las properties `logging.*`, así que el XML es lo único que funciona.) Si tu config usa un encoder/layout custom —por ejemplo un `MaskingPatternLayout` para enmascarar PII— se reutiliza ese mismo layout en el file appender, para no filtrar datos sensibles al disco.
- **Sin Logback**: agrega `logging.file.name` y los `logging.level.*` de Hibernate a `application.properties`/`application.yml` — el archivo base **y todas** las variantes `application-{profile}`.
- **Sin ninguna config**: crea `src/main/resources/application.properties` con lo necesario.

Escribe los archivos in-place y es **idempotente** — correrlo de nuevo no hace más cambios. Después de correrlo, reiniciá tu app, ejercitá los endpoints que disparan queries, y corré `full_scan`.

Antes de tocar nada verifica que el proyecto realmente use **JPA/Hibernate** (dependencias del build, nombre del parent corporativo, imports `javax`/`jakarta.persistence`, `@Entity`, `JpaRepository`). Un servicio reactivo WebFlux + MongoDB o una lambda Python/Node recibe un reporte de **"no aplica"** en vez de config de logging inútil — pasá `force: true` para forzarlo igual. `undo` nunca se bloquea.

| Parámetro | Requerido | Por defecto | Descripción |
|---|---|---|---|
| `projectRoot` | No | directorio de trabajo actual | Raíz del proyecto Spring Boot (donde está `src/main/resources`). |
| `action` | No | `apply` | `apply` configura el logging; `undo` revierte todos los cambios de N1nja. |
| `force` | No | `false` | Salta la verificación de tipo de proyecto y configura igual. |

```json
{ "projectRoot": "/ruta/a/tu-proyecto-spring-boot" }
```

---

### `full_scan` ⭐

El comando todo-en-uno, y el que vas a usar la mayoría de las veces. Pensalo como `analyze_hibernate_log` + `find_n1_in_code` + un reporte escrito a disco, en una sola llamada: parsea el log, escanea el código fuente de Spring Boot, cruza cada patrón SQL con el archivo y método Java exacto que lo causa, y escribe un `.md` detallado con código de fix listo para copiar y pegar (`JOIN FETCH`, `@EntityGraph`, `@BatchSize`, `@Cacheable`, …).

Todos los parámetros tienen un valor por defecto razonable, así que podés llamarlo sin ningún argumento:

| Parámetro | Requerido | Por defecto | Descripción |
|---|---|---|---|
| `logFile` | No | `logs/application.log` | Ruta al archivo de log de Hibernate. Coincide con la config recomendada de Spring Boot (`logging.file.name=logs/application.log`). |
| `projectRoot` | No | directorio de trabajo actual | Raíz del proyecto Spring Boot (donde está `src/main/java`). Por defecto, el directorio donde se inició el proceso del servidor MCP. |
| `outputFile` | No | `report/n1nja-report_{timestamp}.md` | Ruta de salida personalizada para el `.md`. Cada corrida escribe un archivo nuevo con timestamp. |
| `config` | No | — | Override de umbrales de detección (ver *Umbrales de detección*). |
| `force` | No | `false` | Salta la verificación de tipo de proyecto. Por defecto, los proyectos sin JPA/Hibernate (servicios reactivos WebFlux/MongoDB, lambdas Python/Node, …) se omiten con un reporte de "no aplica". |

```json
{ "logFile": "logs/application.log", "projectRoot": "/ruta/a/tu-proyecto-spring-boot" }
```

---

### `analyze_hibernate_log`

Lee un archivo de log y produce un reporte de análisis completo. A diferencia de `full_scan`, este se queda **solo a nivel SQL** — te dice *qué* está mal en el log, pero no escanea tu código Java ni escribe un archivo a disco. Usalo cuando solo necesitás un diagnóstico rápido del log (por ejemplo, para experimentar con umbrales personalizados) sin tocar el código.

| Parámetro | Requerido | Por defecto | Descripción |
|---|---|---|---|
| `logFile` | No | `logs/application.log` | Ruta al archivo de log de la aplicación Spring Boot. Coincide con la config recomendada de Spring Boot (`logging.file.name=logs/application.log`). |
| `config` | No | — | Override de umbrales de detección (ver *Umbrales de detección*). |

```json
// Input
{ "logFile": "/ruta/a/application.log" }

// Output
{
  "summary": {
    "totalQueries": 245,
    "detectedIssues": 3
  },
  "issues": [
    {
      "type": "N_PLUS_1",
      "severity": "HIGH",
      "query": "select * from member where group_id=?",
      "executions": 150,
      "estimatedExtraQueries": 149
    }
  ]
}
```

---

### `find_n1_in_code` ⭐

**Fase 2 — La feature estrella.**

Toma el último reporte y escanea el código fuente de tu proyecto Spring Boot para encontrar:
- Qué clase `@Entity` está causando cada N+1
- Qué campo de asociación (`@OneToMany`, `@ManyToMany`, etc.) se está cargando lazy
- Qué método del service/controller dispara la carga
- Si ocurre dentro de un loop (mayor riesgo)

Luego propone el mejor fix con ejemplos de código funcionando.

| Parámetro | Requerido | Por defecto | Descripción |
|---|---|---|---|
| `projectRoot` | No | directorio de trabajo actual | Ruta absoluta a la raíz del proyecto Spring Boot (donde está `src/main/java`). Si se omite, usa el directorio donde se inició el proceso del servidor MCP. |

```json
// Input — ejecutar después de analyze_hibernate_log
{ "projectRoot": "/ruta/a/tu/proyecto-spring-boot" }

// O usar full_scan para hacer todo en un solo paso:
{ "logFile": "logs/application.log", "projectRoot": "/ruta/a/tu-proyecto-spring-boot" }
```

```
// Ejemplo de salida
🔴 N+1 DETECTADO — severidad HIGH

Entidad:     Group.java
Campo:       members (OneToMany, FETCH=LAZY)
Disparado:   GroupService.java:47 dentro de getGroupSummaries() ⚠️ DENTRO DE UN LOOP

Fix Opción 1: JOIN FETCH
  @Query("SELECT g FROM Group g JOIN FETCH g.members")
  List<Group> findAllWithMembers();

Fix Opción 2: @EntityGraph
  @EntityGraph(attributePaths = {"members"})
  List<Group> findAll();

Fix Opción 3: @BatchSize
  @BatchSize(size = 25)
  @OneToMany(mappedBy = "group")
  private List<Member> members;
```

---

### `find_missing_indexes` 🔍

Conecta a la base de datos y cruza las columnas de WHERE / JOIN ON / ORDER BY de las queries recientes contra el catálogo de índices existentes. Reporta columnas sin índice y genera sentencias `CREATE INDEX` listas para correr.

Trabaja sobre la lista de queries del último reporte, así que corré `analyze_hibernate_log` o `full_scan` primero para poblarla. Si faltan credenciales o falla la conexión, muestra exactamente cómo proveerlas (ver [Credenciales de base de datos](#credenciales-de-base-de-datos)).

| Parámetro | Requerido | Por defecto | Descripción |
|---|---|---|---|
| `envFile` | No | — | Ruta a un archivo `.env` con las variables `DB_*` (por ejemplo, el de tu proyecto Spring). |
| `projectRoot` | No | cwd | Raíz del proyecto Spring Boot — las credenciales se leen de su `application.properties`/`yml` cuando no están en el entorno. |

```json
{}                                              // usa variables de entorno / .env del directorio de trabajo
{ "projectRoot": "C:/work/mi-app-spring" }      // lee spring.datasource.* del proyecto
{ "envFile": "C:/work/mi-app-spring/.env" }     // lee un .env explícito
```

---

### `show_report`

Devuelve el reporte más reciente sin volver a parsear el archivo. El reporte es el último que produjo `analyze_hibernate_log` o el que acumuló `monitor_log`.

| Parámetro | Requerido | Por defecto | Descripción |
|---|---|---|---|
| `format` | No | `json` | Formato de salida: `json`, `markdown`, `both` o `pdf`. |

```json
// Input
{ "format": "markdown" }   // "json" | "markdown" | "both" | "pdf"
```

**Sobre `pdf`:** a diferencia de los formatos de texto, un PDF no se puede devolver inline — así que `format: "pdf"` renderiza el reporte a un archivo estilado (`report/n1nja-report_{timestamp}.pdf`) y devuelve su ruta. Usa el **Edge o Chrome ya instalado en el sistema** en modo headless (`--print-to-pdf`) — sin dependencias extra ni Chromium empaquetado. Si no encuentra ninguno, indicale cuál usar con la variable de entorno `N1NJA_BROWSER` (poné la ruta al ejecutable del browser).

---

### `monitor_log`

Monitorea un archivo de log en **tiempo real**. Donde `analyze_hibernate_log` / `full_scan` leen el log *una vez, de principio a fin* (una foto), `monitor_log` se queda siguiendo el mismo archivo a medida que la app escribe en él (como `tail -f`): cada query nueva se acumula en memoria y los detectores corren en vivo. Ambos leen el mismo tipo de archivo — la diferencia es *cómo*: una lectura de una sola vez vs. tailing continuo.

Esto es lo que te permite **aislar un solo endpoint**: arrancás el monitor, disparás exactamente un request, y ves únicamente el SQL que produjo *esa* acción — sin ruido del resto del log. También es la forma más rápida de validar un fix: lo aplicás, repetís el request, y ves desaparecer el N+1.

| Parámetro | Requerido | Por defecto | Descripción |
|---|---|---|---|
| `action` | No | `start` | Qué hacer: `start`, `stop` o `status`. |
| `logFile` | No | `logs/application.log` | Ruta al archivo de log a vigilar. |

```json
// Iniciar monitoreo
{ "logFile": "logs/application.log", "action": "start" }

// Ver estado
{ "logFile": "logs/application.log", "action": "status" }

// Detener monitoreo
{ "logFile": "logs/application.log", "action": "stop" }
```

**Flujo de trabajo recomendado:**
```
1. monitor_log (start)
2. Navegás la app — activás la feature que querés analizar
3. show_report
4. monitor_log (stop)
```

---

### `explain_sql` 🔬

Ejecuta `EXPLAIN ANALYZE` sobre una o más queries y analiza el plan de ejecución directamente contra tu base de datos. Tiene dos modos, según si le pasás `sql`:

- **Pasás `sql`** → explica esa query puntual (e ignora `maxQueriesToExplain`).
- **Omitís `sql`** → agarra automáticamente las peores queries (N+1 y lentas) del último reporte y explica las top `maxQueriesToExplain`.

| Parámetro | Requerido | Por defecto | Descripción |
|---|---|---|---|
| `sql` | No | — | Query SQL cruda a explicar. Si se omite, se usan las top queries del último reporte. |
| `maxQueriesToExplain` | No | `3` | Cuando se omite `sql`, cuántas de las top queries del reporte explicar. |
| `envFile` | No | — | Ruta a un archivo `.env` con las variables `DB_*` (por ejemplo, el de tu proyecto Spring). |
| `projectRoot` | No | cwd | Raíz del proyecto Spring Boot — las credenciales se leen de su `application.properties`/`yml` cuando no están en el entorno. |

```json
// Opción A — explicar una query específica
{ "sql": "select * from member where group_id = 1" }

// Opción B — explicar automáticamente las top N+1/slow queries del último reporte
{ "maxQueriesToExplain": 3 }

// Opción C — tomar las credenciales directamente del proyecto Spring
{ "projectRoot": "C:/work/mi-app-spring" }
```

**Qué detecta:**

| Issue | Descripción |
|---|---|
| `SEQ_SCAN` | Full table scan — no se usa ningún índice |
| `MISSING_INDEX` | La columna de join/filtro no tiene índice |
| `SORT_WITHOUT_INDEX` | ORDER BY fuerza un sort en memoria |
| `HIGH_ROWS_REMOVED` | El filtro descarta >90% de las filas leídas |
| `NESTED_LOOP_ON_LARGE_TABLE` | Join O(n×m) en tablas grandes |
| `HIGH_COST` | El costo del plan supera 100k |
| `MYSQL_FULL_TABLE_SCAN` | Equivalente MySQL del Seq Scan |
| `MYSQL_FILESORT` | MySQL ordena en un archivo temporal |

<a id="credenciales-de-base-de-datos"></a>
**Credenciales de base de datos** — se resuelven en este orden (gana el primer set completo):

1. **Parámetro `envFile`** — una ruta explícita a un archivo `.env` con las variables `DB_*`. El archivo ya no necesita vivir donde corre el MCP.
2. **Variables de entorno** (o un `.env` en el directorio de trabajo):
   ```env
   DB_TYPE=postgresql
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=tu_base_de_datos
   DB_USER=tu_usuario
   DB_PASSWORD=tu_contraseña
   ```
3. **La config de tu proyecto Spring** — pasá `projectRoot` (o ejecutá desde el directorio del proyecto) y N1nja lee `src/main/resources/application.properties` / `application.yml` automáticamente. También soporta archivos de perfil (`application-{profile}.properties|yml`, ej. `application-ci.yml`): si el archivo base no tiene datasource, prueba los perfiles mergeados sobre la base, priorizando `SPRING_PROFILES_ACTIVE` o el `spring.profiles.active` de la base.
   ```properties
   spring.datasource.url=jdbc:postgresql://localhost:5432/tu_base_de_datos
   spring.datasource.username=tu_usuario
   spring.datasource.password=tu_contraseña
   ```
   Los placeholders `${VAR}` / `${VAR:default}` se resuelven contra el entorno; las URLs `jdbc:mariadb:` se tratan como MySQL.

**Ejemplo de salida:**
```
🔴 SEQ_SCAN — HIGH
Tabla: member | Costo: 52,480 | Filas: 850,000

Full sequential scan. La base de datos está leyendo cada fila.

Recomendación:
  CREATE INDEX idx_member_group_id ON member (group_id);
  O en JPA: @Index(name = "idx_member_group_id", columnList = "group_id")
```

---

## 💬 Ejemplos de uso

Una vez instalado, hablale a Claude de forma natural. Estas son conversaciones reales:

---

### 🔴 Escenario 1 — "Mi app está lenta, no sé por qué"

```
Vos:    Analizá mis logs de Hibernate en logs/application.log

Claude: 🥷 Parsing log file: application.log
        ✴️  48.320 líneas procesadas — 312 queries encontradas
        ✅ 4 problemas detectados

        ## 🔴 N+1 DETECTADO — HIGH

        Query: SELECT * FROM member WHERE group_id = ?
        Ejecuciones: 150 veces en una ventana de 0.3s
        Queries extra estimadas: 149

        Query padre: SELECT * FROM groups
        → Cada Group cargado → luego members cargados uno por uno

        Fix: Agregá JOIN FETCH en tu repositorio:
          @Query("SELECT g FROM Group g JOIN FETCH g.members")
          List<Group> findAllWithMembers();
```

---

### 🔍 Escenario 2 — Monitoreo en tiempo real mientras usás la app

```
Vos:    Empezá a monitorear logs/application.log

Claude: ✅ Watcher activo — escuchando SQL de Hibernate

Vos:    [navegás la app — usás la feature que querés analizar]

Vos:    ¿Qué encontraste?

Claude: show_report → 3 problemas detectados en los últimos 2 minutos:
        - N+1 en Order.items (87 queries extra)
        - DUPLICATE_QUERY: findById(userId) llamado 5 veces en 1 request
        - MISSING_PAGINATION en /api/productos (sin cláusula LIMIT)

Vos:    Pará el monitoreo

Claude: ✅ Watcher detenido
```

---

### 🧠 Escenario 3 — Encontrá el código exacto que causa el N+1

```
Vos:    ¿Qué clase y método está causando este N+1?
        Mi proyecto está en /ruta/a/shop-api

Claude: 🥷 Escaneando proyecto: shop-api
        ✴️  12 entidades JPA encontradas
        ✅ Análisis de código completo — 2 hallazgos

        ## Hallazgo 1 — HIGH

        Entidad:   Order.java
        Campo:     items (@OneToMany, FETCH=LAZY)
        Origen:    OrderService.java:83 dentro de getOrderSummaries()
                   ⚠️ DENTRO DE UN FOR LOOP — riesgo máximo

        Fix Opción 1 — JOIN FETCH (recomendado):
          @Query("SELECT o FROM Order o JOIN FETCH o.items")
          List<Order> findAllWithItems();

        Fix Opción 2 — @EntityGraph:
          @EntityGraph(attributePaths = {"items"})
          List<Order> findAll();
```

---

### 📊 Escenario 4 — Analizá el plan de ejecución de la DB

```
Vos:    Corré EXPLAIN en las queries más lentas del último reporte

Claude: 🥷 Conectando a la base de datos...
        ✴️  Conectado a postgresql @ localhost
        ✴️  EXPLAIN query 1/3...
        ✅ Análisis completo — 2 problemas de plan encontrados

        ## 🔴 SEQ_SCAN — HIGH
        Tabla: member | Costo: 52.480 | Rows descartados: 91%

        Scan completo de tabla en cada request.

        Fix:
          CREATE INDEX idx_member_group_id ON member (group_id);
          -- o en JPA:
          @Index(name = "idx_member_group_id", columnList = "group_id")
```

---

### ⚙️ Escenario 5 — Ajustá los umbrales de detección

```
Vos:    Analizá logs/application.log pero marcá como N+1
        cualquier query que se repita más de 3 veces,
        y como lenta cualquier query que tarde más de 200ms

Claude: [corre con config personalizada]
        nPlusOneThreshold: 3
        slowQueryMs: 200

        ✅ 9 problemas detectados (vs 4 con umbrales por defecto)
```

---

## 📂 Archivos de ejemplo

La carpeta [`examples/`](examples/) contiene archivos de muestra listos para usar, así
podés probar N1nja sin tener que generar tus propios datos primero:

| Archivo | Qué es |
| --- | --- |
| [`examples/sample.log`](examples/sample.log) | Un log de Hibernate de muestra con un N+1 de manual (una query a `groups` y después una query por cada grupo a `member`). Usalo como input de `analyze_hibernate_log`. |
| [`examples/sample-report.json`](examples/sample-report.json) | Un ejemplo del reporte JSON que produce N1nja después de analizar un log. |
| [`examples/detector-config.json`](examples/detector-config.json) | Una config de detectores de muestra con todos los umbrales ajustables (`nPlusOneThreshold`, `slowQueryMs`, …). Pasala como argumento `config` para sobreescribir los valores por defecto. |
| [`examples/mcp-config.json`](examples/mcp-config.json) | El snippet `mcpServers` para registrar N1nja en tu cliente MCP (Claude Code / Claude Desktop). |

Probalo:

```
Analizá mis logs de Hibernate en examples/sample.log
```

---

## 🔎 Reglas de detección

### N+1 Query

Se activa cuando la misma query normalizada se ejecuta más de `nPlusOneThreshold` veces:

```sql
-- Este patrón en tus logs:
SELECT * FROM member WHERE group_id = 1;
SELECT * FROM member WHERE group_id = 2;
SELECT * FROM member WHERE group_id = 3;
-- ... 147 veces más

-- Se normaliza a:
SELECT * FROM member WHERE group_id = ?
-- Detectado: 150 ejecuciones → N+1
```

### Duplicate Query

La misma query repetida innecesariamente — generalmente un `@Cacheable` faltante o un `findById()` dentro de un loop.

### Missing Pagination

`SELECT *` sin `LIMIT`/`OFFSET`/`FETCH FIRST` en un full-table scan.

### Large Result Set

Queries que devuelven más de `largeResultThreshold` filas en total.

### Slow Query

Queries cuyo tiempo de ejecución medido supera `slowQueryMs`. El timing se toma de las líneas con tiempo transcurrido que tu app loguea después de cada query (`"took 80ms"`, `"completed in 46ms"`, `"Time: 33ms"`, …). Las queries sin timing medido igual se revisan con una heurística **por patrones** (falta de WHERE en joins grandes, `LIKE '%…%'`, etc.) y se marcan como sospechosas de lentas.

### Posible Producto Cartesiano

Múltiples `JOIN FETCH` en asociaciones de colecciones sin `DISTINCT` — trampa clásica de Hibernate.

### Over-fetching

Dos estrategias. Las queries con `SELECT *` literal se marcan directamente. Además, cuando hay `projectRoot` disponible, N1nja compara las columnas que trae cada query contra los getters de la entidad que realmente usa el método Java que la disparó — las columnas traídas pero nunca leídas se reportan como **over-fetching a nivel de columnas**. Ambas recomiendan proyecciones DTO.

### Deadlock / Lock Timeout

Escanea el log en busca de errores de lock de PostgreSQL (`deadlock detected`, `could not obtain lock`), MySQL (`Lock wait timeout exceeded`, `Deadlock found`) e Hibernate/JPA (`PessimisticLockException`, `LockTimeoutException`).

---

## 🧪 Testing

```bash
# Correr todos los tests
npm test

# Modo watch
npm run test:watch

# Reporte de coverage
npm run test:coverage

# Solo chequeo de tipos TypeScript
npm run typecheck
```

**Cobertura de tests:**

| Suite | Tests | Qué cubre |
|---|---|---|
| `sql-normalizer.test.ts` | 18 | Normalización de UUID, string, numérico, fecha, IN-lists, lowercase, whitespace |
| `log-parser.test.ts` | 10 | Prefijo Hibernate:, prefijo DEBUG, bind params, multi-query, estadísticas, timestamps, patrón default y custom de thread de Spring Boot |
| `n-plus-one.test.ts` | 5 | Umbral, inferencia de query padre, exclusión sin WHERE, config personalizada |
| `detectors.test.ts` | 14 | Detección de paginación, duplicados, slow query, producto cartesiano |
| `over-fetching-large-result.test.ts` | 15 | Over-fetching con SELECT * y result sets grandes |
| `explain-analyzer.test.ts` | 12 | Análisis del plan EXPLAIN (seq scan, índice faltante, filesort, nested loops) |
| `slow-query-timing.test.ts` | 9 | Timing de slow queries desde las estadísticas de Hibernate |
| `deadlock.test.ts` | 5 | Detección de deadlock / lock timeout (PostgreSQL, MySQL, Hibernate) |
| `registry.test.ts` | 6 | Registro de herramientas MCP — schemas, defaults, params opcionales |
| `combined-report.test.ts` | 4 | Generación del reporte combinado log + código |
| `spring-datasource.test.ts` | 18 | Resolución de credenciales de DB — parsing de URL JDBC, `.properties`/`.yml`, perfiles de Spring, precedencia de `envFile` |

---

## 🤝 Contribuir

¡Las contribuciones son bienvenidas! Mirá [CONTRIBUTING-ES.md](CONTRIBUTING-ES.md) para el
flujo de trabajo, cómo agregar un nuevo detector y las convenciones de código.

Inicio rápido:

```bash
git checkout -b feature/tu-feature
npm test && npm run typecheck && npm run lint
```

---

## 📄 Licencia

MIT © 2026 — Ver [LICENSE](LICENSE) para más detalles.

---

<div align="center">

🥷 **N1nja** — Construido para [Claude Code](https://claude.ai/code) · Potenciado por [Model Context Protocol](https://modelcontextprotocol.io/)

</div>
