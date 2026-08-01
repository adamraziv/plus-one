

# Plus One

[![Última versión](https://img.shields.io/github/v/release/adamraziv/plus-one)](https://github.com/adamraziv/plus-one/releases/latest)
[![Licencia](https://img.shields.io/github/license/adamraziv/plus-one)](LICENSE)
[![Contribuir](https://img.shields.io/badge/contributing-guide-blue)](CONTRIBUTING.md)

Plus One es un agente de finanzas domésticas de código abierto y autoalojado para parejas. El canal de producción de la v0.1.0 es Telegram; los límites del canal están diseñados para integraciones adicionales.

Los agentes pueden analizar y proponer, pero los servicios deterministas y las restricciones de PostgreSQL deciden qué se confirma.

Última versión: [Plus One v0.1.0](https://github.com/adamraziv/plus-one/releases/tag/v0.1.0).

## Alcance Actual

La superficie de agente implementada incluye:

- `orchestrator`: recibe solicitudes, coordina el trabajo y devuelve la respuesta final
- `query`: límite de lectura para datos financieros domésticos
- `accounting`: propone y verifica mutaciones de libros y de ingestión

La superficie de producción actual incluye:

- una puerta de enlace de Telegram con emparejamiento, verificación de estado, apagado ordenado, deduplicación de retransmisiones y una CLI/TUI para operadores
- consultas de cuentas, saldos, transacciones e informes regulados en lenguaje natural
- captura multironda de gastos e ingresos con aclaración, creación de cuentas/categorías respaldada por confirmación y reanudación duradera y segura ante reinicios
- mutaciones validadas con validación de políticas, idempotencia, verificación, lectura de confirmación, restricciones de PostgreSQL y hechos contables de solo adición (append-only)
- ingestión e importación con extracción, coincidencia de duplicados, conciliación y cierre de período
- servicios de planificación, informes y entrega programada
- Memoria de Trabajo duradera del hogar y de sus miembros para objetivos, preferencias, nombres y convenciones, con vistas seguras, cambios confirmados, correcciones, eliminación y revisión determinista o programada

## Cómo Funciona

En la práctica, esto significa:

- las lecturas pasan por herramientas de consulta reguladas
- las escrituras pasan por verificación de dos pasos (maker-checker) y comandos tipados
- los hechos contables permanecen como de solo adición (append-only)
- las restricciones de la base de datos siguen siendo la capa final de cumplimiento

## Requisitos

- Node.js `>=22.13.0`
- pnpm `10.20.0`
- Docker
- una clave `LLM_API_KEY` para ejecuciones respaldadas por modelos en vivo

## Inicio Rápido

```bash
pnpm install
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm db:verify
pnpm smoke:orchestrator
pnpm install:cli
```

`.env.example` contiene los valores predeterminados para el desarrollo local de los roles de la base de datos y las cadenas de conexión.

El instalador crea un enlace simbólico en `~/.local/bin/plus-one`. Agregue ese directorio a `PATH` si no está presente. Establezca `PLUS_ONE_BIN_DIR` para instalar en un directorio bin diferente. El enlace simbólico apunta a este clon del repositorio; no copia archivos `.env` ni secretos.

## Ejecutar Plus One

El comando instalado es independiente del directorio de trabajo actual:

```bash
cd /tmp
plus-one
```

Sin argumentos, `plus-one` inicia la puerta de enlace de producción en segundo plano. Imprime un estado inicial, espera a que el servidor HTTP de Mastra y el receptor de Telegram configurado estén listos, imprime el estado de escucha y devuelve el indicador de la terminal. La salida desacoplada de la puerta de enlace se escribe en el directorio de estado de Plus One.

```bash
plus-one status
plus-one stop
```

`status` informa si la puerta de enlace está detenida, iniciando o escuchando. `stop` finaliza el proceso registrado de la puerta de enlace sin detener PostgreSQL. El modo interno `--foreground` es utilizado por `plus-one live` y no es una interfaz de chat.

La puerta de enlace de producción expone:

```text
GET /health/live
GET /health/ready
POST /plus-one/inbound
```

`/health/ready` se marca como listo únicamente después de que los recursos de la aplicación y la entrada del canal estén activos. El apagado ordenado detiene la entrada antes de cerrar el servidor HTTP y los recursos de la aplicación. Los mensajes de seguimiento aceptados se procesan en orden FIFO por conversación.

El comando no tiene modo de chat. `plus-one chat ...` se rechaza, y las interfaces de terminal nunca envían texto de conversación ingresado por el operador. La entrada de conversación es exclusivamente por canal.

## Servidor de Desarrollo

Para el desarrollo local de Mastra en el repositorio, ejecute:

```bash
pnpm dev:mastra
```

## Registro (Logs)

El entorno de ejecución escribe registros de diagnóstico legibles y rotativos en `~/.plus-one/logs`:

```text
~/.plus-one/logs/agent.log
~/.plus-one/logs/errors.log
~/.plus-one/logs/gateway.log
```

Configure la ubicación y la rotación con:

- `PLUS_ONE_HOME`: directorio principal de Plus One; los registros se escriben en su subdirectorio `logs/`
- `PLUS_ONE_LOG_LEVEL`: `DEBUG`, `INFO`, `WARNING` o `ERROR` (predeterminado `INFO`)
- `PLUS_ONE_LOG_MAX_SIZE_MB`: tamaño de rotación de `agent.log` y `gateway.log` (predeterminado `5`)
- `PLUS_ONE_LOG_BACKUP_COUNT`: cantidad de copias de seguridad rotativas para `agent.log` y `gateway.log` (predeterminado `3`)

Inspeccione los registros desde la CLI:

```bash
pnpm plus-one logs
pnpm plus-one logs gateway --follow
pnpm plus-one logs --conversation conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K
```

Los diagnósticos contienen metadatos del ciclo de vida y ID de correlación, no cuerpos de mensajes, indicaciones (prompts), respuestas del modelo, cargas financieras, argumentos de herramientas ni destinos de transporte. Las transcripciones, auditorías y registros operativos de PostgreSQL permanecen como almacenes autoritativos independientes.

Esto utiliza la CLI de Mastra instalada en el espacio de trabajo e inicia el servidor HTTP de desarrollo local. No activa el sondeo de Telegram ni registra el webhook de producción. De forma predeterminada, Mastra sirve Studio en `http://localhost:4111`.

Para la interfaz de usuario terminal operativa, ejecute:

```bash
plus-one live
```

La interfaz en vivo inicia, detiene, oculta e inspecciona la puerta de enlace y gestiona el emparejamiento de Telegram. Es una consola para operadores, no un cliente de chat.

Los comandos de emparejamiento también están disponibles sin la TUI:

```bash
plus-one telegram pairing list-pending
plus-one telegram pairing approve <code> --household <household_id>
plus-one telegram pairing revoke <telegram_user_id>
```

La superficie de API incorporada de Mastra permanece en `http://localhost:4111/api`, pero la ruta de entrada personalizada de Plus One se registra directamente y no tiene el prefijo `/api`.

La ruta de entrada de Plus One está disponible en:

```text
POST http://localhost:4111/plus-one/inbound
```

Las cargas útiles de entrada deben cumplir con `InboundChannelMessageV1`. En particular:

- `conversationId` debe coincidir con `conversation_<ULID de 26 caracteres>`
- `householdId` debe coincidir con `hh_<ULID de 26 caracteres>`

El entorno de ejecución actual persiste:

- memoria de transcripciones en `mastra_memory.mastra_messages` y `mastra_memory.mastra_threads`
- instantáneas de flujos de trabajo del orquestador en `mastra_memory.mastra_workflow_snapshot`

## Comandos Comunes

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:db
pnpm test:integration
pnpm test:acceptance
pnpm db:up
pnpm db:down
pnpm db:migrate
pnpm db:verify
pnpm smoke:orchestrator
pnpm dev:mastra
pnpm install:cli
plus-one
plus-one status
plus-one stop
plus-one live
```

## Estructura del Repositorio

- `apps/engine`: inicialización de la aplicación, orquestador, agentes, flujos de trabajo y rutas de ejecución
- `packages/contracts`: esquemas compartidos y contratos de dominio
- `packages/runtime`: primitivas de ejecución, políticas, herramientas, artefactos y programación
- `packages/database`: configuración de PostgreSQL, pools, migraciones y adaptadores de repositorio
- `packages/accounting`: publicación de libros, mutaciones contables y lógica del equipo contable
- `packages/query`: herramientas de consulta, validación de SQL y manejo de evidencias
- `packages/ingestion`: soporte para importación, extracción, coincidencia y conciliación
- `packages/planning`: repositorios y servicios del dominio de planificación
- `packages/reporting`: proyecciones de informes y servicios del dominio de informes
- `database`: migraciones de SQL, scripts de inicialización y reparación
- `test`: ayudantes compartidos más cobertura de base de datos, integración y aceptación

## Estado de la Versión

La v0.1.0 es el primer lanzamiento público de desarrollo. Proporciona un flujo de finanzas funcional para Telegram autoalojado, aunque las APIs, la configuración y el comportamiento operativo aún pueden cambiar antes de la 1.0.

Si es nuevo en la base de código, comience con `apps/engine`, `packages/runtime`, `packages/database`, `packages/query` y `packages/accounting`.
