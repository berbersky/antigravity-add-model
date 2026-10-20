<p align="center">
  <img src="gateway/dashboard/antigravity-logo.png" width="96" height="96" alt="Logotipo de Google Antigravity">
</p>

<h1 align="center">Antigravity Custom Model Enabler</h1>

<p align="center">
  <strong>Tus proveedores y modelos locales, dentro de Antigravity.</strong><br>
  Gestión de modelos para la aplicación de escritorio, Antigravity IDE y una pasarela opcional.
</p>

<p align="center">
  <a href="https://github.com/vahapogut/antigravity-add-model/actions/workflows/ci.yml"><img src="https://github.com/vahapogut/antigravity-add-model/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="#instalación"><img src="https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22.13 o posterior"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-2563eb" alt="Licencia Apache 2.0"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README_zh.md">简体中文</a> · <strong>Español</strong> · <a href="README_tr.md">Türkçe</a> · <a href="README_ru.md">Русский</a> · <a href="README_hi.md">हिन्दी</a> · <a href="README_ar.md">العربية</a>
</p>

<p align="center">
  <a href="#instalación"><strong>Inicio rápido</strong></a> ·
  <a href="#añadir-modelos">Añadir modelos</a> ·
  <a href="#pasarela-y-acceso-remoto">Acceso remoto</a> ·
  <a href="#documentación-y-contribuciones">Documentación</a> ·
  <a href="https://github.com/vahapogut/antigravity-add-model/issues">Ayuda</a>
</p>

Añade API externas y modelos locales junto a los modelos integrados de Antigravity. Configúralos en el administrador de modelos y selecciónalos al conversar. La pasarela opcional añade enrutamiento centralizado, historial y un panel web.

Esta es una guía resumida en español. Las guías técnicas enlazadas están en **inglés**; los nombres de botones y opciones se mantienen como aparecen en la interfaz.

> [!IMPORTANT]
> La **aplicación de escritorio independiente basada en Electron** y **Antigravity IDE, basado en VS Code**, usan instalaciones diferentes. El IDE necesita su [adaptador de configuración y administrador web local](docs/ide.md), no el instalador de la aplicación independiente. Revisa la [compatibilidad](docs/compatibility.md) antes de instalar. El alcance de las pruebas del IDE se detalla en los [resultados de validación](docs/ide.md#validation-boundary); no se garantiza compatibilidad con todas las versiones futuras.

## Funciones

| Función | Incluye |
| --- | --- |
| Administrar modelos | Búsqueda, grupos por proveedor, edición, duplicación, activación y descubrimiento de modelos. |
| Conectar servicios | OpenAI, Anthropic, Gemini, OpenRouter, Cloudflare Workers AI y otras API compatibles; Ollama, LM Studio, vLLM y otros servidores locales. |
| Ajustar solicitudes | Formato de API, razonamiento, límites de contexto y salida, cabeceras, tiempos de espera, reintentos y modelos alternativos. |
| Elegir modelos de subagentes | En clientes compatibles con `invoke_subagent`; el IDE también admite tareas de texto independientes mediante [herramientas MCP](docs/ide.md#delegate-to-custom-models-with-mcp). |
| Gestionar cuentas de Google | Hasta 50 cuentas por modelo, inicio de sesión con **Antigravity account** desde una instalación reconocida del IDE **2.5.5**, o con tu propio cliente OAuth; preparación del proyecto, almacenamiento cifrado, consulta de cuota y selección automática de cuentas elegibles. La sesión existente del IDE es independiente. |
| Tarjetas de cuentas | Panel plegable, activación, edición de etiquetas, retirada de cuentas de los grupos y selección Preferred/Automatic. Cada grupo conserva su proyecto y cuota; el plan solo se muestra si lo informa el proveedor. El interruptor native fallback usa únicamente un grupo Cloud Code con coincidencia exacta del modelo, sin recurrir a la API pública de Gemini. [Detalles](docs/configuration.md#quota-panel-and-preferred-accounts). |
| Estimar el contexto visible | Un anillo de solo lectura junto al selector nativo reconocido muestra `~` para estimaciones y `?` si el uso es desconocido. Excluye instrucciones ocultas, definiciones de herramientas e imágenes. El límite configurado tiene prioridad; un clic permite buscar el límite ausente en el catálogo público models.dev, con límites de tiempo y tamaño y sin guardar cambios. [Alcance](docs/configuration.md#native-context-estimate). |
| Revisar solicitudes | Diagnósticos, latencia, uso de tokens y una prueba explícita de generación. |
| Usar una pasarela | Panel web, alias, proveedores alternativos, historial y acceso remoto autenticado. |

Los catálogos de proveedores como OpenRouter pueden ofrecer cientos de modelos. La disponibilidad real depende del proveedor, la cuenta y las capacidades que necesite tu tarea. Consulta [proveedores y descubrimiento](docs/providers.md) y la [comparación de funciones](docs/feature-parity.md).

## Capturas

<p align="center">
  <a href="assets/model_manager.jpg"><img src="assets/model_manager.jpg" width="1000" alt="Administrador de modelos con búsqueda, grupos por proveedor e importación"></a>
</p>

<p align="center">
  <a href="assets/model_editor.jpg"><img src="assets/model_editor.jpg" width="1000" alt="Editor de modelos con proveedor, formato de API y opciones avanzadas"></a>
</p>

*Controles actuales del complemento, mostrados en una demostración aislada con configuraciones ilustrativas. Haz clic para ampliar. Hay más [capturas en el README en inglés](README.md#screenshots).*

## Instalación

Necesitas Git, **Node.js 22.13 o posterior** y la aplicación de Antigravity que quieras configurar.

```sh
git clone https://github.com/vahapogut/antigravity-add-model.git
cd antigravity-add-model
npm ci --ignore-scripts
npm run build
```

Si ya tienes el repositorio, actualiza tu copia y vuelve a ejecutar los comandos de dependencias y compilación.

### Antigravity IDE

Usa este flujo para el **IDE basado en VS Code**. Sustituye la ruta de ejemplo por la carpeta `resources` de tu instalación:

```sh
npm run ide:check -- --resources "/path/to/Antigravity IDE/resources"
npm run ide:apply -- --resources "/path/to/Antigravity IDE/resources"
npm run proxy:start -- --open
npm run ide:launch -- --resources "/path/to/Antigravity IDE/resources"
```

Completa el inicio de sesión de Google en el propio IDE. Añade los modelos personalizados en el administrador web local. La ruta del proxy para modelos personalizados se aplica a sesiones locales; se conserva el enrutamiento del proveedor para WSL. Consulta la [guía del IDE](docs/ide.md) para perfiles, directorios de datos y restauración.

### Aplicación de escritorio independiente

Cierra Antigravity y su servidor de lenguaje. Desde el repositorio:

```sh
node scripts/deploy.mjs --check
node scripts/deploy.mjs
```

El primer comando comprueba la compatibilidad sin modificar la instalación. El segundo aplica el complemento, conserva copias de seguridad y revierte una instalación fallida. Vuelve a abrir Antigravity cuando termine correctamente.

Si no se detecta la aplicación, usa la misma ruta explícita en ambos comandos:

```sh
node scripts/deploy.mjs --check --resources "/path/to/Antigravity/resources"
node scripts/deploy.mjs --resources "/path/to/Antigravity/resources"
```

`--resources` admite una carpeta Resources, una carpeta de instalación o una aplicación `.app` de macOS. Los diseños desconocidos se rechazan. Los envoltorios `./deploy.ps1`, `bash deploy.sh` y `bash deploy_linux.sh` usan el mismo instalador. Algunas versiones de Windows requieren el [parche opcional del endpoint](docs/compatibility.md#optional-windows-language-server-endpoint-patch), que utiliza el puerto 50999.

## Añadir modelos

1. En la aplicación de escritorio, abre **Settings → Models & Usage** y **Custom Models → Add model**. En el IDE, usa el administrador web que abre `npm run proxy:start -- --open`.
2. Selecciona el proveedor e introduce **API URL** y **API key** cuando sean necesarios.
3. Introduce el **Provider model ID** exacto y pulsa **Test connection → Save model**, o usa **Fetch provider models**, selecciona los modelos y pulsa **Add selected**.
4. Selecciona el modelo guardado en el selector del chat.

Para modelos locales, inicia primero el servidor y pulsa **Discover local**. El descubrimiento de puertos se realiza cuando lo solicitas. **Advanced settings** permite ajustar el formato de API, razonamiento, límites, cabeceras, reintentos y modelos alternativos.

> [!NOTE]
> **Test connection** verifica la autenticación y el listado de modelos. No genera una respuesta ni demuestra que exista cuota para generar. Si el proveedor no ofrece un catálogo, introduce el modelo manualmente.

Consulta la [configuración completa](docs/configuration.md), los [requisitos de imágenes](docs/configuration.md#image-inputs) y la [guía de Cloudflare Workers AI](docs/workers-ai-setup.md).

Para cuentas de Google, elige **Google Cloud Code account pool** y sigue la [configuración de cuentas](docs/configuration.md#google-cloud-code-account-pools). Usa **Antigravity account** con una instalación reconocida del IDE **2.5.5**, o **My Desktop OAuth client** con tu propio cliente. Repite el inicio de sesión para añadir cuentas y guarda el modelo; este flujo no importa ni sustituye la sesión existente del IDE. Un 403 indica un problema de acceso; un 429 indica un límite; un 503 puede afectar al proveedor aunque cambies de cuenta.

## Pasarela y acceso remoto

Puedes usar los proveedores directamente. Instala la pasarela si necesitas gestión centralizada, historial o acceso desde otro equipo:

```sh
npm run gateway:install
npm run gateway:build
npm run gateway -- setup --non-interactive
npm run gateway -- start
```

La configuración imprime localmente el token generado y los datos de acceso al panel. Abre `http://127.0.0.1:51001`, inicia sesión y configura proveedores y alias de modelos.

En **Remote gateway**, usa estos valores para una instalación local:

| Campo | Valor |
| --- | --- |
| Gateway URL | `http://127.0.0.1:51000` |
| Gateway token | El token generado durante la configuración |
| Dashboard URL | `http://127.0.0.1:51001` |

Pulsa **Test gateway → Import model aliases**. Los alias importados aparecen como modelos. Para revisar o detener la pasarela, usa `npm run gateway -- status`, `npm run gateway -- logs` y `npm run gateway -- stop`.

Para acceder desde otro equipo, puedes reenviar ambos puertos mediante SSH:

```sh
ssh -N -L 51000:127.0.0.1:51000 -L 51001:127.0.0.1:51001 user@gateway-host
```

Mantén el túnel abierto y usa las mismas URL locales. Ambos servicios escuchan en loopback de forma predeterminada. Para HTTPS o una dirección de red explícita, consulta [acceso remoto](gateway/README.md#remote-access). El historial de la pasarela contiene prompts, respuestas y argumentos de herramientas; los costes mostrados son estimaciones.

## Credenciales y datos

Los modelos se guardan normalmente en `~/.gemini/antigravity/custom_models.json`. Las credenciales guardadas se cifran y se ocultan en el editor. Si no se usa el almacén seguro del sistema, el cifrado local AES-256-GCM utiliza `~/.gemini/antigravity/.model-credentials-key`; conserva esa clave en tus copias privadas. El servicio Node del IDE no puede descifrar credenciales guardadas con `safeStorage` de Electron: vuelve a introducirlas en su administrador o usa un directorio de datos separado.

**Export** omite claves de API, cabeceras personalizadas, tokens de Google y secretos de clientes OAuth. Usa **Export / Import** para compartir configuraciones y añade las credenciales en el equipo de destino. La pasarela mantiene su propio perfil en `~/.gemini/antigravity/gateway` y su historial puede contener datos sensibles.

Los servicios locales y la pasarela tienen controles de acceso distintos. Mantén privadas las URL de administración con token y sigue las guías de [datos y credenciales](docs/configuration.md#credentials-and-data), [seguridad del IDE](docs/ide.md#model-manager-and-credentials) y [almacenamiento de la pasarela](gateway/README.md#lifecycle-and-data).

## Diagnóstico y recuperación

Después de actualizar Antigravity, vuelve a compilar y comprobar la compatibilidad antes de reinstalar el complemento.

| Objetivo | Comando |
| --- | --- |
| Revisar compilación, configuración y servicios | `npm run doctor` |
| Obtener diagnóstico JSON | `npm run doctor -- --json` |
| Comprobar una instalación | `npm run patch:check -- --resources "/path/to/Resources"` |
| Reaplicar el complemento | `npm run doctor:repair -- --resources "/path/to/Resources"` |
| Restaurar la copia del instalador | `npm run patch:restore -- --resources "/path/to/Resources"` |

Cierra la aplicación antes de reparar o restaurar. La restauración no sobrescribe una instalación modificada por una actualización posterior. Si aparece `NOT_SUPPORTED`, comprueba el tipo de aplicación y su versión. Ante una pantalla negra, sigue la [recuperación tras actualizaciones](docs/compatibility.md#black-screen-after-an-update). Para el IDE, usa su [procedimiento de estado y restauración](docs/ide.md#status-and-recovery).

## Documentación y contribuciones

Las siguientes guías están en inglés:

| Guía | Contenido |
| --- | --- |
| [Configuración](docs/configuration.md) | Campos, importación, cuentas de Google y datos |
| [Proveedores](docs/providers.md) | Endpoints, catálogos y requisitos de acceso |
| [Cloudflare Workers AI](docs/workers-ai-setup.md) | Configuración específica de Workers AI |
| [Antigravity IDE](docs/ide.md) | Instalación, administrador web y delegación MCP |
| [Pasarela](gateway/README.md) | Panel, enrutamiento, historial y acceso remoto |
| [Compatibilidad](docs/compatibility.md) | Versiones, copias de seguridad y recuperación |
| [Comparación de funciones](docs/feature-parity.md) | Funciones implementadas y límites |
| [Registro de cambios](CHANGELOG.md) | Cambios actuales e historial |

El complemento está escrito en TypeScript en `src/` y se compila en `dist/`. Para desarrollar:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run lint
```

Para cambios en la pasarela o pruebas de integración:

```sh
npm run gateway:install
npm run gateway:build
npm run gateway:test
npm run test:integration
```

Las pruebas de CI usan proveedores locales simulados e instalaciones aisladas en Windows, macOS y Linux. No validan todas las credenciales reales ni todas las versiones de Antigravity. Las contribuciones deben incluir pruebas relevantes y la compilación actualizada. Para informar de un fallo, [abre una incidencia](https://github.com/vahapogut/antigravity-add-model/issues) con el tipo y versión de aplicación, sistema operativo y diagnóstico sin secretos.

## Licencia y créditos

[Licencia Apache 2.0](LICENSE). Los componentes adaptados de la pasarela conservan su [licencia MIT](gateway/LICENSE.upstream) y [atribución original](gateway/UPSTREAM.md).

El logotipo de Antigravity procede de los [recursos de prensa oficiales de Google](https://antigravity.google/press).

Mantenido por **[vahapogut](https://github.com/vahapogut)** · [LinkedIn](https://www.linkedin.com/in/abdulvahap-ogut-343992398/)
