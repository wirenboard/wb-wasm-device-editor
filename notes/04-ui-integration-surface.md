# 04 — DALI UI integration surface (homeui → wb-wasm-device-editor)

Paths relative to `/home/boger/work/board/tmp/daliwasm/wb-wasm-device-editor/`.
`HF = submodule/homeui/frontend`.

---

## 1. Mount point

### 1.1 Angular glue (the thing we replace)

`HF/app/scripts/react-directives/dali/daliDirective.jsx:1-31`

```jsx
export default function daliDirective(whenMqttReady, DaliProxy, mqttClient) {
  setReactLocale();                                   // :9
  ... link(scope, element) {
    scope.store = new DaliStore(whenMqttReady, DaliProxy, mqttClient);   // :18
    scope.root = ReactDOM.createRoot(element[0]);
    scope.root.render(<DaliPage store={scope.store} />);                 // :22
    element.on('$destroy', () => { scope.store.destroy(); scope.root.unmount(); });  // :25-28
  }
}
```

Angular DI supplies the three ctor args (`HF/app/scripts/app.js:122` registers `DaliProxy`;
`whenMqttReady` + `mqttClient` come from `HF/app/scripts/services/mqttService.js:11,16`).
Route: `HF/app/scripts/app.routes.js:349-355`, `template: '<dali-page />'`.

**The whole React contract is one prop: `store`.** No context, no router, no provider.

### 1.2 `DaliStore` constructor contract

`HF/src/stores/dali/dali-store.ts:9-27`

```ts
constructor(
  whenMqttReady: () => Promise<void>,   // resolves when broker connected; awaited once in load()
  daliProxy:     DaliProxy,             // HF/src/stores/dali/types.ts:131-144
  mqttClient:    any,                   // passed straight to BusStore -> MonitorStore
)
```

* `load()` (`:29-60`) — `await whenMqttReady()` then `daliProxy.GetList()`; builds
  `GatewayStore[]` → `BusStore[]` → `DeviceStore[]`, then `busStore.syncGroupChildren()`.
* `destroy()` (`:62-68`) — iterates gateways→buses→`bus.destroy()` (unsubscribes commissioning topic).
* `errors: ErrorInfo[]` (`@/layouts/page`), set via `formatError`.
* `gateways` is `observable.shallow`; the store uses `makeObservable`, **not** decorators, so
  the wasm app's `configure({ enforceActions: 'never' })` in `wasm/src/main.tsx:12` is fine.

### 1.3 Page props

`HF/src/pages/settings/configs/dali/types.ts` → `DaliPageProps = { store: DaliStore }`.
Default export is `observer(DaliPage)` (`dali.tsx:66,155`).

### 1.4 Everything the DALI tree imports from outside `dali/` and `stores/dali/`

Full enumeration (from `grep "from '"` over both trees):

| Import | File:line | Notes |
|---|---|---|
| `mobx`, `mobx-react-lite`, `react`, `react-i18next` | everywhere | already used by wasm app |
| `classnames` | bus-tab-content:1, group-tab-content:1 | aliased in vite config |
| **`react-responsive`** (`useMediaQuery`) | `dali.tsx:4` | **not aliased**, resolves from `HF/node_modules` (present) |
| `@/components/alert` | dali.tsx:5, commissioning-error-banner:3, reset-confirm:3 | |
| `@/components/button` | dali.tsx:6 + 4 more | |
| `@/components/tree` | dali.tsx:7 | pulls `@/components/checkbox`, 2 svg icons |
| `@/layouts/page` (`PageLayout`) | dali.tsx:8; `ErrorInfo` type in dali-store.ts:2 | **see 1.5** |
| `@/stores/auth` (`authStore`, `UserRole`) | dali.tsx:9,107 | **see 1.5** |
| `@/components/card` | bus-tab-content:6 | |
| `@/components/form` (`FormButtonGroup`, `BooleanField`) | bus-tab-content:7, device-tab-content:5, lunatone:4 | |
| `@/components/form/field-label`, `.../form-field` | polling-interval-field:4-5, lunatone:5-6 | |
| `@/components/input` | polling-interval-field:6, lunatone:7 | |
| `@/components/json-schema-editor` | bus-tab-content:8, group-tab-content:6, device-tab-content:6 | already used by wasm |
| `@/components/loader` | bus/group/gateway/device tab contents | |
| `@/components/progress` | commissioning-progress:4 | |
| `@/components/switch` | bus-monitor:7 | |
| `@/components/tooltip` | bus-monitor:8, device-tab-content:8 | `@floating-ui/react` |
| `@/components/confirm`, `@/components/radio` | reset-confirm:4-5 | |
| `@/assets/icons/{clear,visibility,visibility-off}.svg` | bus-monitor:4-6 | svgr |
| `@/utils/async-action` | 5 files | already used by wasm |
| `@/stores/json-schema-editor` (+`/object-store`) | all 4 dali stores, bus/group tab content | already used by wasm |
| `@/utils/formatError` | dali-store.ts:3, base-item-store.ts:2 | |

**Nothing in the DALI page tree or `stores/dali` touches Angular, `$rootScope`,
`$q`, `angular.*`, `ui-router`, `oclazyload`, `uiStore`, or a global service.**
`mqttClient` and `daliProxy` are injected as opaque `any`.

### 1.5 The two things that reach into homeui-only "global" state

1. **`PageLayout`** (`HF/src/layouts/page/page.tsx:13-126`). Pure presentational; no context,
   no router. Props at `HF/src/layouts/page/types.ts:16-32`. The wasm app **already uses it**
   (`wasm/src/device-settings-wasm/device-settings-wasm.tsx:13,556`) — so nesting a second
   `PageLayout` inside the existing one is the only real concern (see §6/§7).
2. **`authStore`** (`HF/src/stores/auth/index.ts:127`, module-level singleton).
   `dali.tsx:107` calls `authStore.hasRights(UserRole.Admin)`. Before `checkAuth()` runs,
   `userRole` is `undefined` → `hasRights()` returns **`false`** (`auth-store.ts:106-108`)
   → `PageLayout` renders `t('page.access-denied')` and **hides all children**.
   `checkAuth()` does `GET /auth/who_am_i` via axios (`HF/src/utils/request.ts:3`) — there is
   no such endpoint in the wasm app.
   → **Do not pass `authStore.hasRights(...)`.** Either render `<DaliPage>` with a patched
   `hasRights` or, better, set `authStore.userRole = UserRole.Admin` once at wasm bootstrap
   (one line, no fork of the page). Cheapest non-invasive form:
   `import { authStore, UserRole } from '@/stores/auth'; authStore.userRole = UserRole.Admin;`

   Side effect: `axios` (+ `HF/src/utils/request.ts`) enters the bundle. Confirmed present in
   the probe bundle (§8). ~50 KB; acceptable.

---

## 2. `daliProxy` contract

### 2.1 Definition

`HF/app/scripts/services/daliProxy.js:1-22`

```js
MqttRpc.getProxy('wb-mqtt-dali/Editor',
  ['GetList','GetGateway','SetGateway','GetBus','SetBus','ScanBus','StopScanBus',
   'GetDevice','SetDevice','GetGroup','SetGroup','IdentifyDevice',
   'ResetDeviceSettings','ResetDevice'],
  'daliProxy');
```

`getProxy` (`HF/app/scripts/services/rpc.js:200-210`) returns an object whose each method is
`proxy._call.bind(proxy, method)`, plus `hasMethod(name)`.

Note: the TS interface `DaliProxy` (`HF/src/stores/dali/types.ts:131-144`) is **missing**
`ResetDeviceSettings` and `ResetDevice`, which `device-store.ts:104,115` do call. The stores
type `daliProxy` as `any` (`base-item-store.ts:18`) so it compiles. Our shim must implement
all 14.

### 2.2 Wire format — exactly what `_call` does

`HF/app/scripts/services/rpc.js:113-166`

* prefix: `this._prefix = '/rpc/v1/' + target + '/'` → `/rpc/v1/wb-mqtt-dali/Editor/`
* `_init()` (`:122-124`) subscribes **once** (sticky) to
  `` `/rpc/v1/wb-mqtt-dali/Editor/+/${mqttClient.getID()}/reply` ``
  (single-level `+` wildcard covering all method names).
* request topic (`:136`): `` `/rpc/v1/wb-mqtt-dali/Editor/${Method}/${mqttClient.getID()}` ``
* publish (`:138-145`): `mqttClient.send(topic, JSON.stringify({ id: callId, params: params || {} }), false)`
  — **`retained = false`**, `qos` omitted → defaults to **1** (`mqttService.js:396`).
* `callId` is a module-global monotonic integer starting at 1 (`rpc.js:31`), **shared across all proxies**.
* reply topic is `<requestTopic>/reply`. Payload is JSON with an `id` matching the request
  (`rpc.js:87-103`); unparseable / id-less / unknown-id replies are logged and dropped.
* Topic check (`:160-161`): if `actualTopic !== topic + '/reply'` → reject with the raw
  string `'unexpected response topic ' + actualTopic`.
* Success: `resolve(reply.result)`. Error: `reply.error` present **and non-null** → `reject(reply.error)`.
* Timeout: `mqttRpcTimeout = 60000` ms (`rpc.js:6`), armed with `mqttClient.timeout(...)`
  (which itself only starts counting **after retained replay finished** — `mqttService.js:118-124`).
  On fire → reject `{ data: 'MqttTimeoutError', message: 'MQTT RPC request timed out' }` (`rpc.js:26-29`).
* Disconnection: `$rootScope.$watch(mqttClient.isConnected)` (`rpc.js:69-77`); on transition to
  false, every in-flight call rejects with
  `{ data: 'MqttConnectionError', message: 'MQTT client is not connected' }` (`rpc.js:21-24`).
  Also `_call` rejects immediately if `!mqttClient.isConnected()` (`:131-134`).
* `Spinner.start/stop(spinnerIdPrefix, callId)` (`:156,158`) — global UI spinner; **drop it in the shim**.
* `hasMethod(m)` (`rpc.js:169-196`) subscribes to the bare method topic and resolves true if a
  retained message arrives within `mqttRpcMethodAvailableTimeout = 3000` ms, else false.
  **Not used by the DALI stores** — safe to stub as `() => Promise.resolve(true)`.

### 2.3 How errors reach the UI

Reject value → `catch (error) { this.setError(error) }` in every store method
(e.g. `dali-store.ts:53-54`, `bus-store.ts:88-90`, `device-store.ts:57-58`, `gateway-store.ts:43-44`).

* `DaliStore.setError` (`dali-store.ts:70-76`) → `this.errors = [{ variant: 'danger', text: formatError(error) }]`
  → rendered as an `<Alert variant="danger">` by `PageLayout` (`page.tsx:97-106`).
* `BaseItemStore.setError` (`base-item-store.ts:26-28`) → `this.error = formatError(error)`
  → rendered by `dali.tsx:140-142` as `<Alert variant="danger">`.

`formatError` (`HF/src/utils/formatError.ts:1-13`):

```ts
if (typeof error === 'object') {
  if (rpcError.code) {
    if (typeof rpcError.data === 'object' && data !== null) return `${message}: ${data.message}(${code})`;
    return `${message}: ${data}(${code})`;
  }
  return rpcError.message ?? '';       // <- MqttTimeoutError / MqttConnectionError land here
}
return String(error);
```

So a JSON-RPC error `{code:-32000, message:"Bus error", data:"timeout"}` renders as
`Bus error: timeout(-32000)`. A transport error renders as its bare `message`.
Note `typeof null === 'object'` → a `null` reject renders as `''`. Keep that behaviour.

### 2.4 Shim shape

```ts
type RpcError = { code?: number; message?: string; data?: unknown };
function makeDaliProxy(mqttClient, opts = { timeoutMs: 60000 }): DaliProxy
```
must reproduce: single sticky `+/<clientId>/reply` subscription, monotonic ids, retained=false,
`{id, params}` body, resolve `reply.result` / reject `reply.error`, timeout + disconnect errors
with **exactly** the `{data, message}` shape (no `code`), so `formatError` output is unchanged.

---

## 3. `mqttClient` contract

### 3.1 Every use in `stores/dali/**`

| Call | Site | Signature |
|---|---|---|
| `addStickySubscription(topic, cb)` | `bus-store.ts:266` — topic `` `/wb-dali/${busId}/commissioning` `` (`:48`) | `cb({topic, payload, qos, retained})` |
| `unsubscribe(topic)` | `bus-store.ts:271` | by exact topic string |
| `addStickySubscription(topic, cb)` | `monitor-store.ts:52` — topic `` `/wb-dali/${busMqttId}/bus_monitor` `` (`:20`) | ring buffer, 500 msgs (`:51,54-57`) |
| `unsubscribe(topic)` | `monitor-store.ts:63` | |

That's **all**. `getID()`, `send()`, `isConnected()`, `timeout()`, `cancel()` are used only by
`rpc.js`, i.e. only by whatever we build for §2.

Payload shapes:
* `/wb-dali/<busId>/commissioning` → JSON `CommissioningState`
  (`HF/src/stores/dali/types.ts:24-31`): `{status, progress, error, device_count, devices, finished_at}`.
  Empty payload is ignored (`bus-store.ts:254-256`); parse failure warns and returns (`:257-263`).
  **Almost certainly retained** — `DaliStore.load()` also gets `bus.commissioning` from `GetList`
  (`dali-store.ts:41`), and `BusStore` seeds from it (`bus-store.ts:73`), so a retained replay
  simply re-applies the same state.
* `/wb-dali/<busId>/bus_monitor` → plain text line, `payload.trim()` pushed to `logs`.

### 3.2 Reference implementation semantics (`HF/app/scripts/services/mqttService.js`)

Must be replicated by the shim:

* **`getID()`** (`:200-202`) — the client id passed to `connect()`; used in RPC topics.
* **`send(destination, payload, retained, qos)`** (`:376-408`)
  – `qos` defaults to **1**, `retained` defaults to **true** when `undefined`;
  – prepends `globalPrefix` (`/client/<user>` only when `localStorage.prefix === 'true'`, `:88-89`) — **our shim: `globalPrefix = ''`**;
  – flow control: max 100 in-flight QoS>0 messages, rest queued (`:4,184-189,384-388`).
* **`subscribe(topic, cb)`** (`:262-275`) — pushes into `callbackMap[topic]` (array per pattern);
  no-op + `console.error` when disconnected.
* **`addStickySubscription(topic, cb)`** (`:278-281`) — records in `stickySubscriptions` **and**
  subscribes now if connected; on (re)connect all sticky subs are re-subscribed (`:218`).
  *Duplicate-safe?* No: calling it twice with the same topic registers two callbacks.
  `MonitorStore._subscribeToTopic` (`:50-59`) creates a **new closure each time**, and
  `toggleLogsReception` (`:35-44`) unsubscribes/resubscribes — `unsubscribe` deletes the whole
  `callbackMap[topic]` entry, so it stays balanced. Preserve that: **`unsubscribe` removes all
  callbacks for the topic**, not just one.
* **`unsubscribe(topic)`** (`:283-294`) — drops sticky entry, `delete callbackMap[topic]`,
  `client.unsubscribe(...)` guarded by try/catch.
* **Wildcard matching** (`topicMatches`, `:43-57`) — `+` = one level, `#` = rest (must be last).
  Dispatch iterates `Object.keys(callbackMap).sort()` and calls every matching pattern's callbacks
  (`:347-368`). **The RPC reply subscription depends on `+` support.**
* **Retained replay / "retain hack"** (`:117-124, 148-151, 220-225, 337-342`) —
  on connect the client subscribes to `/tmp/<clientId>/retain_hack` and publishes `1` (qos 2) to it;
  the arrival of that message means "all retained messages already delivered", resolving
  `retainReady`. `service.timeout()` only arms its timer **after** `retainReady`, so RPC timeouts
  never fire during retained flood. `whenReady()`/`isReady()` expose it.
  → In an in-browser broker the shim can resolve `retainReady` immediately, but keep the
  `timeout(cb, ms)` / `cancel(promise)` pair, because they are what §2 uses.
* **`isConnected()`** (`:420-423`) — also writes into `uiStore`; our shim must **not** import `uiStore`.
* **`whenMqttReady()`** (`:19-40`) — factory returning `() => Promise<void>` that resolves when
  `mqttClient.isConnected()` becomes true. Trivial to reimplement without `$rootScope.$watch`.

**Minimum shim surface:** `getID()`, `isConnected()`, `send(topic, payload, retained, qos?)`,
`addStickySubscription(topic, cb)`, `unsubscribe(topic)`, `timeout(cb, ms)`, `cancel(handle)`,
plus a `whenMqttReady()` companion. Callback arg must be `{ topic, payload, qos, retained }`
with `payload` a **string**.

---

## 4. JSON-schema editor

### 4.1 schema + config → form

1. `loadJsonSchema(rawSchema, externalDefs?)` — `HF/src/stores/json-schema-editor/json-schema-loader.ts:298-313`.
   Expands `$ref` (`#/definitions/...`, with a ref cache, `:88-99`), flattens `allOf` (`:9-63`),
   normalises `oneOf` into `{type:'oneOf', oneOf:[...]}` (`:65-86`), and **whitelists**
   custom props via `sanitizeCustomProperties`/`sanitizeOptions` (`:101-159`). Also copies
   top-level `translations` and `device` onto the result (`:310-311`).
2. `new ObjectStore(schema, config, required, new StoreBuilder())` —
   `HF/src/stores/json-schema-editor/object-store.ts:64-113`. Iterates `schema.properties`
   sorted by `comparePropertyOrder` (`propertyOrder ?? 10000`, tie → `localeCompare`, `:54-62`),
   builds an `ObjectParamStore` per key holding a leaf `PropertyStore`.
3. `StoreBuilder.createStore` (`store-builder.ts:11-52`) dispatches on `schema.format` first
   (`wb-serial-int`, `wb-int-address`, `wb-serial-number` → `StringStore`; `wb-byte-array` →
   `ByteArrayStore`), then on `schema.type`.
4. `<JsonSchemaEditor store={objectStore} translator={translator} />` —
   `HF/src/components/json-schema-editor/json-schema-editor.tsx:175-199`. Renders via
   `DefaultEditorBuilder` (`:28-173`), all leaf editors lazily imported (`:15-26`).
5. Reading back: `objectStore.value` (a `JsonObject`), `isDirty`, `hasErrors`, `commit()`,
   `getParamByKey(key)`. DALI saves either the whole object (`device-store.ts:72`) or a single
   key (`bus-store.ts:159`, `group-store.ts:56`).

Per-item usage in DALI: `bus-store.ts:130-134`, `device-store.ts:47-50`, `group-store.ts:32-36`
(note: `GroupStore` passes the whole RPC response `data` to `loadJsonSchema`, not `data.schema`,
then `setDefault()` on an empty config).

### 4.2 Custom schema extensions

`HF/src/stores/json-schema-editor/types.ts:8-108`.

`options`:
`hidden`, `compact`, `show_opt_in`, `grid_columns` (12-slot flex row layout — used by
`bus-tab-content.tsx:19,28-33,70-79`), `inputAttributes.placeholder`, `patternmessage`,
`enum_titles`, and `options.wb.{show_editor, disable_title, omit_default, allow_undefined,
read_only, new_row, dali_tc}`.
`options.wb.dali_tc = { minimum, maximum, mode: 'value' | 'limit' }` (`types.ts:8-16`) is
**DALI-specific**.

`format` dispatch (`json-schema-editor.tsx`):

| `format` | type | editor | file |
|---|---|---|---|
| `dali-rgb` | string | `DaliRGBEditor` | `dali-rgb-param-editor.tsx` (Colorpicker + 3× `ChannelSlider`, `r;g;b` string, 255 = MASK) |
| `dali-white` | number | `DaliWhiteEditor` | `dali-white-param-editor.tsx` (one `ChannelSlider`, 255 = MASK) |
| `dali-tc` | number | `DaliColorTemperatureSliderEditor` | `dali-color-temperature-slider-param-editor.tsx` (mirek↔Kelvin `K = 1e6/mirek`, MASK = 65535, `Range` + `Switch`) |
| `dali-level` | number | `DaliLevelSliderEditor` | `level-slider-param-editor.tsx` (IEC 62386-102 log dimming curve; reads `rootStore` to pick log/linear) |
| `table` | array of object | `ObjectArrayTableEditor` | |
| `wb-serial-int` / `wb-int-address` / `wb-serial-number` / `wb-byte-array` | — | handled in `StoreBuilder` | |

`ChannelSlider` (`components/channel-slider.tsx`) is shared by rgb/white; MASK = 255 toggled
via `Switch`.

### 4.3 homeui-only infrastructure?

**None.** The editor's outward imports are only `@/components/{button,card,checkbox,colorpicker,
dialog,dropdown,input,range,switch,table}`, `@/assets/icons/*.svg`, `@/utils/color`,
`classnames`, `mobx-react-lite`, `react`, `react-i18next`. No Angular, no MQTT, no auth, no router.
The wasm app already imports `@/components/json-schema-editor`
(`wasm/src/device-settings-wasm/components/{tab-content,sub-group-content,device-settings-view}`),
so the dali-* editors come along for free — they are just lazy chunks not previously reached.

Translations inside a schema: `Translator` (`stores/json-schema-editor/translator.ts:3-22`)
— `addTranslations(schema.translations)` then `find(key, lang)` with `en` fallback then the key
itself. Purely data-driven from the RPC payload; nothing to configure.

---

## 5. i18n

### 5.1 Keys used

`useTranslation()` / `t()` keys in the DALI tree (28 distinct):
`dali.title`, `dali.labels.{group, bus-monitor, bus-settings, websocket-enabled,
websocket-description, websocket-port, websocket-port-error, polling-interval,
polling-interval-error, identify-tooltip, no-gateways, scan-error, scan-stage-*,
reset-dialog-heading, reset-settings-option-{title,description},
reset-device-option-{title,description}, reset-unsaved-warning}`,
`dali.buttons.{rescan, stop-scan, return, reload, clear-log, pause-log, resume-log, set,
identify, reset, reset-confirm}`, plus `common.buttons.save` (`device-tab-content.tsx:67`).
`<Trans i18nKey="dali.labels.no-gateways" components={[<a href="#!/serial-config" />]}/>`
(`dali.tsx:121-124`).

Transitively, from shared components: `page.{not-found, not-found-description, access-denied}`
(`layouts/page/page.tsx:42,45,110`), `common.buttons.edit` (`page.tsx:82`),
`json-editor.errors.*` and `json-editor.labels.{select-params, dali-mask,
dali-mask-tc-limit-not-set}`.

### 5.2 Where they live

`HF/app/scripts/i18n/react/locales/en/translations.json` and `.../ru/translations.json`
(single `translations` namespace, nested objects). **Verified: both files already contain the
full `dali` subtree, plus `page`, `common`, `json-editor`.**

### 5.3 What the wasm app does

`wasm/src/i18n/config.ts:1-31` already imports **exactly those two files** via the `~` alias and
merges them with the wasm-only `wasm.*` bundle:

```ts
resources: { en: { translations: { ...engLocale, ...engModuleLocale } }, ru: {...} },
ns: ['translations'], defaultNS: 'translations',
react: { transSupportBasicHtmlNodes: true },
```

### 5.4 Plan

**Nothing to do — `dali.*` already resolves today.** Concretely:

1. No new resource bundle, no namespace change. `transSupportBasicHtmlNodes: true` is already set,
   which the `<Trans>` in `dali.tsx:121` needs.
2. Change the `no-gateways` link target: `#!/serial-config` is a homeui Angular route and is dead
   in the wasm app. Either accept a dead anchor or shadow the key with a wasm-local override in
   `wasm/src/i18n/{en,ru}/translations.json` (they are spread **after** the homeui bundle, so a
   `dali` key there would *replace* the whole subtree — override must be done by deep-merge, or
   just leave it).
3. Caveat (pre-existing): `wasm/src/device-settings-wasm/device-settings-wasm.tsx:16` imports
   `setReactLocale` from `~/react-directives/locale`, whose module `~/i18n/react/config.js:4`
   calls `i18n.use(initReactI18next).init(...)` on the **same i18next default singleton** with
   only the homeui bundle. Import-time evaluation runs before `configI18n()` in `main.tsx:16`,
   so the wasm config wins — but it is fragile. If DALI is mounted from a new entry that does
   *not* import `device-settings-wasm`, make sure `configI18n()` still runs. Prefer calling
   `i18n.changeLanguage(...)` directly instead of `setReactLocale()` in new code.

---

## 6. Styling

### 6.1 What the DALI page needs

Component-local CSS (co-located, imported by the component — comes for free):
* `HF/src/pages/settings/configs/dali/styles.css` (imported `dali.tsx:16`) — `.dali`,
  `.dali-list`, `.dali-content`, `.dali-contentLoader`, `.dali-deviceToolbar`, `.dali-resetWarning`
* `.../components/bus-monitor/styles.css` (bus-monitor.tsx:11)
* `.../components/bus-tab-content/styles.css` (bus-tab-content.tsx:17)
* `.../components/group-tab-content/styles.css` (group-tab-content.tsx:11)
* every `@/components/*` and `@/layouts/page` brings its own `styles.css`.

CSS custom properties referenced: `--border-color`, `--card-border-radius`,
`--background-accent-color-hover`, `--background-color`. **All defined** in
`HF/src/assets/styles/variables.css:4,21,62` (and dark-theme overrides at `:116,128`).

### 6.2 What the wasm app pulls in today

`wasm/src/main.tsx:5-10`:
```
'@/assets/styles/animations.css'
'@/assets/styles/variables.css'
'~styles/main.css'
'~styles/css/bootstrap.min.css'
'~styles/css/new.css'
'~styles/css/device-manager.css'
```
Plus `wasm/src/device-settings-wasm/styles.css` (imported at `device-settings-wasm.tsx:26`).
No `~styles` imports anywhere else.

### 6.3 Concrete missing-style risks

1. **`.rulesConsole-button` / `.rulesConsole-icon`** — used by `bus-monitor.tsx:50-51,55,57`
   for the clear-log and pause-log icon buttons. Defined **only** in
   `HF/src/components/rules-console/styles.css:61-91`, which the DALI tree does not import.
   → Those two buttons render as raw `<button>` with a full-size SVG.
   Fix: add `.rulesConsole-button{...}` equivalents to a wasm-local `dali-overrides.css`,
   or import `@/components/rules-console/styles.css` (pulls only CSS if imported directly).
   *(This is latent in homeui too — it only works there because the rules-console chunk
   happens to be loaded.)*
2. **`.page-container` conflict.** `HF/src/layouts/page/styles.css:1-3,91-97` defines it twice:
   `min-height:100%` and `max-height:100%; overflow:auto; display:flex; flex-direction:column;
   flex-grow:1`. `wasm/src/device-settings-wasm/styles.css:1-5` **overrides it globally** with
   `max-height:none; overflow:visible; padding-bottom:48px`.
   `dali.tsx:117` passes `stickyHeader`, which wraps children in `<div className="page-container">`
   (`page.tsx:118`) and relies on that scroll container; `.dali{height:100%;overflow:auto}` and
   `.dali-content{overflow-y:scroll}` then size against it.
   → With the wasm override in effect, the DALI two-pane layout will not size/scroll correctly.
   Fix: scope the wasm override (`.deviceSettingsWasm-page .page-container {...}`) or add a
   counter-rule under a `.dali-page` wrapper class.
3. **`#page-wrapper` / `.wrapper-content` sizing.** `~styles/main.css:13-40` sizes homeui's
   Angular shell (`#wrapper` = `100vh` flex column). `wasm/index.html` has only `<div id="root">`
   — those rules never apply, and `body`/`#root` have no explicit height. `.dali{height:100%}`
   therefore collapses. → Give `html,body,#root { height:100% }` (or set an explicit
   `height: calc(100vh - …)` on the DALI wrapper).
4. `.dali-busMonitorContent { height: 500px }` is fixed — fine, no risk.
5. `@floating-ui/react` (Tooltip/Dialog) and `react-select` (Dropdown) styles already work in the
   wasm app, so Tooltip/Confirm in the DALI tree are safe.
6. Fonts: `--font: 'Roboto'` — already however the existing app handles it; unchanged.

---

## 7. Existing app shell and where DALI goes

### 7.1 Navigation today

There is **no router and no navigation**. `wasm/src/main.tsx:18`:

```tsx
createRoot(document.querySelector('#root')).render(<DeviceSettingsWasm />);
```

`DeviceSettingsWasm` (`wasm/src/device-settings-wasm/device-settings-wasm.tsx:28-830`) is a single
`PageLayout` (`:556`) whose `actions` (`:558-607`) hold: offline/update indicators, "Add device",
"Select port", "Scan", "Save", and an EN/RU `Dropdown`. Its body is a two-column
`<main className="deviceSettingsWasm-container">` — an `<aside>` with a vertical `Tabs` list of
scanned Modbus devices (`:688-724`) and a `<section>` with `DeviceSettingsView` (`:726-...`).
Sub-navigation between devices is the `Tabs` component keyed by `slave_id`.

### 7.2 Proposal — smallest change

Add a **top-level view switch in `main.tsx`**, keeping `DeviceSettingsWasm` byte-identical.
A hash check is enough (`#dali`), no router dependency:

`wasm/src/main.tsx` (modified — 6 lines):
```tsx
import { useSyncExternalStore } from 'react';
import { DeviceSettingsWasm } from './device-settings-wasm';
import { DaliWasm } from './dali-wasm';
...
const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};
const App = () => {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return hash === '#dali' ? <DaliWasm /> : <DeviceSettingsWasm />;
};
createRoot(document.querySelector('#root')).render(<App />);
```
plus one extra style import: `import './dali-wasm/styles.css';` (or keep it inside the module).

Entry point into the DALI view: add one `<Button>` to the existing `actions` block
(`device-settings-wasm.tsx:558`), e.g.
`<Button label={t('wasm.buttons.dali')} variant="secondary" onClick={() => { location.hash = '#dali'; }} />`,
and a mirrored "back" button inside `DaliWasm`. This touches the Modbus editor in exactly one
place and cannot change its behaviour.

### 7.3 New files

```
wasm/src/dali-wasm/
  index.ts                 export { DaliWasm } from './dali-wasm';
  dali-wasm.tsx            the view (see below)
  mqtt-client.ts           MqttClientShim  (§3.2 surface)
  dali-proxy.ts            makeDaliProxy(mqttClient)  (§2.4)
  styles.css               .rulesConsole-* fallbacks + .page-container un-override (§6.3)
```

`wasm/src/dali-wasm/dali-wasm.tsx`:
```tsx
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { authStore, UserRole } from '@/stores/auth';
import { DaliStore } from '@/stores/dali';
import DaliPage from '@/pages/settings/configs/dali';
import { createMqttClient } from './mqtt-client';
import { makeDaliProxy } from './dali-proxy';
import './styles.css';

export const DaliWasm = () => {
  const store = useMemo(() => {
    authStore.userRole = UserRole.Admin;            // see §1.5
    const mqttClient = createMqttClient();          // in-browser broker
    return new DaliStore(
      () => mqttClient.whenConnected(),
      makeDaliProxy(mqttClient),
      mqttClient,
    );
  }, []);
  useEffect(() => () => store.destroy(), [store]);  // mirrors daliDirective's $destroy
  return <DaliPage store={store} />;
};
```

`wasm/src/dali-wasm/dali-proxy.ts` imports only `./mqtt-client` +
`type { DaliProxy } from '@/stores/dali/types'` (note: not re-exported from
`@/stores/dali/index.ts`, so import the file directly, and extend it locally with
`ResetDevice` / `ResetDeviceSettings`).

No change needed to `wasm/vite.config.ts` (aliases already cover `@`, `~`, `~styles`) or to
`wasm/src/i18n/config.ts`.

---

## 8. Build sanity

### 8.1 `npx tsc --noEmit -p tsconfig.json` in `wasm/` — **currently FAILS** (exit 2, 84 errors)

All 84 are `TS2307: Cannot find module`, in two groups:
* `@/...` and `@/pages/...`, `@/stores/...`, `@/components/...`, `@/layouts/page`,
  `@/assets/icons/*.svg` — because **`wasm/tsconfig.json` has no `@/*` path mapping**
  (only `~/*`, `~scripts/*`, `~styles/*`). The `@` alias exists **only** in `vite.config.ts:139`.
* `react-i18next`, `mobx`, `mobx-react-lite`, `classnames` — not installed in `wasm/node_modules`
  (only aliased to `HF/node_modules` by vite).
* Plus `~/react-directives/locale` (a `.js` file with no types).

Type-checking is therefore **not part of the build** — `npm run build` is plain `vite build`
(`wasm/package.json`), and vite/esbuild strip types without checking. This is the pre-existing
state on `master` with a clean tree; **DALI does not change it.** Importing the DALI page would
add more of the same `TS2307` lines, nothing new in kind.

### 8.2 Would DALI introduce type errors? — probe (outside the repo)

Probe at `<scratch>/probe/` — an `entry.tsx` doing
`new DaliStore(async()=>{}, {} as any, {} as any)` + `<DaliPage store={store}/>`, with a tsconfig
mapping `@/* → HF/src/*`, `~/* → HF/app/scripts/*`, `moduleResolution: bundler`,
homeui `typeRoots` + `HF/src/custom.d.ts`:

**Zero `TS2307`.** 8 real errors, all **pre-existing homeui `src/` type bugs** in files the DALI
tree happens to pull in (homeui's own `tsconfig.json` only `include`s `app/scripts`, so `src/`
is never type-checked there either):

```
src/components/dropdown/dropdown.tsx(79,19)  TS2339 'options' does not exist on type Option<unknown>
src/components/dropdown/dropdown.tsx(80,22)  TS2339 same
src/components/dropdown/dropdown.tsx(126,28) TS2339 'hidden' does not exist on type unknown
src/components/json-schema-editor/object-array-table-param-editor.tsx(55,46) TS2339 'properties' on JsonSchema|JsonSchema[]
src/components/json-schema-editor/object-array-table-param-editor.tsx(60,29) TS2339 'options' on unknown
src/components/json-schema-editor/object-array-table-param-editor.tsx(61,24) TS2339 'options' on unknown
src/components/json-schema-editor/object-array-table-param-editor.tsx(63,39) TS2339 'title' on unknown
src/utils/formatError.ts(6,54)               TS2339 'message' does not exist on type object
```
`dropdown.tsx` and `object-array-table-param-editor.tsx` are already reachable from the existing
wasm app, so only `formatError.ts` is genuinely new — and it is not compiled today anyway.

### 8.3 Module resolution / bundling — probe (outside the repo)

Vite 7.3.0 lib-mode build at `<scratch>/probe2/` with `node_modules` symlinked to
`wasm/node_modules` and **the exact alias map from `wasm/vite.config.ts:136-152`** (including the
`react`/`react-dom`/`mobx`/`classnames`/… pins to `HF/node_modules` and `dedupe`):

```
✓ 407 modules transformed.
dist/probe.css                                   31.97 kB
dist/entry-*.js                               1,329.61 kB │ gzip: 327.46 kB
+ lazy chunks: dali-rgb-, dali-white-, dali-color-temperature-slider-,
  level-slider-, channel-slider-, range-, object-array-table-, object-,
  array-, boolean-, boolean-array-, byte-array-param-editor
✓ built in 4.85s
```

**No unresolved imports, no missing packages.** `react-responsive` (not in the alias list) and
`axios` (via `authStore` → `@/utils/request`) both resolve from `HF/node_modules` by normal
node_modules walk-up from the importing file. Only benign rollup warnings about modules that are
both statically and dynamically imported (`info.svg`, `number-param-editor`, `string-param-editor`).

Consequence: **the DALI page bundles cleanly into the wasm app as-is.** The work is entirely in
(a) the `mqttClient` + `daliProxy` shims, (b) the `authStore.hasRights` bypass, and (c) the three
CSS issues in §6.3.
