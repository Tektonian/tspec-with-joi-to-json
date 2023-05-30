# Generating Document



## CLI Usage

### **`generate`**

Generate OpenAPI schema from TypeScript types.

#### Usage

::: code-group
```bash [yarn]
yarn tspec generate [options]
```

```bash [npm]
npx tspec generate [options]
```

```bash [pnpm]
pnpx tspec generate [options]
```
:::

#### Options

|Option|Type|Description|Example|
|-|-|-|-|
|`--specPathGlobs [path]`|string[]|Path of TypeScript files which you want to generate OpenAPI schema|`src/**/*.ts`|
|`--tsconfigPath [path]`|string|Path of tsconfig|`./tsconfig.json`|
|`--outputPath [path]`|string|Path of output OpenAPI schema|`./generate/openapi.yaml`|
|`--specVersion [version]`|number|Version to use for OpenAPI schema (Currently supports only 3)|`3`|
|`--openapiTitle [title]`|string|`title` property of OpenAPI schema|`Tspec`|
|`--openapiVersion [version]`|string|`version` property of OpenAPI schema|`1.0.0`|
|`--debug [true / false]`|boolean|Print debug information for Tspec|`false`|
|`--ignoreErrors [true / false]`|boolean|Whether ignore errors in Tspec or not|`false`|


::: details Configuring generating options with configuration file

You can also use configuration file for generating Tspec.

To use it, configure Tspec with `tspec.config.json` file and locate it at the root of your project.

The type of configuration file is defined `Tspec.GenerateParams` type.

The following is an example of `tspec.config.json` file.

::: code-group
```json[tspec.config.json]
{
  "specPathGlobs": ["src/**/*.ts"],
  "tsconfigPath": "./tsconfig.json",
  "outputPath": "./generate/openapi.json",
  "specVersion": 3,
  "openapi": {
    "title": "Tspec API",
    "version": "0.0.1",
    "servers": ["https://tspec.org", "http://localhost:3000"],
    "securityDefinitions": {
      "jwt": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "JWT",
      },
    },
  },
  "debug": false,
  "ignoreErrors": true,
}
```
:::

### **`server`**

Start Tspec server for display OpenAPI schema with Swagger.

#### Usage

::: code-group
```bash [yarn]
yarn tspec server [options]
```

```bash [npm]
npx tspec server [options]
```

```bash [pnpm]
pnpx tspec server [options]
```
:::

#### Options

**You can also use the CLI options for [`generate`](#generate) command.**

|Option|Type|Description|Example|
|-|-|-|-|
|`--port [port]`|number|Specify port number for Tspec server|`7080`|
|`--proxyHost [host]`|string|Specify proxy host for Tspec server|`https://tspec.org`|



## Programmatic Usage

### **`generate`**


```ts
import { generateTspec, Tspec } from 'tspec';

const options: Tspec.GenerateParams = {
  specPathGlobs: ['src/**/*.ts'],
  tsconfigPath: './tsconfig.json',
  outputPath: './generate/openapi.json',
  specVersion: 3,
  openapi: {
    title: 'Tspec API',
    version: '0.0.1',
    servers: ['https://tspec.org', 'http://localhost:3000'],
    securityDefinitions: {
      jwt: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
  },
  debug: false,
  ignoreErrors: true,
};

const openApiSpec = await generateTspec(options);
```


### **`server`**

```ts
import { initTspecServer, Tspec } from 'tspec';

const options: Tspec.InitTspecServerOptions = {
  specPathGlobs: ['src/**/*.ts'],
  tsconfigPath: './tsconfig.json',
  outputPath: './generate/openapi.json',
  specVersion: 3,
  openapi: {
    title: 'Tspec API',
    version: '0.0.1',
    servers: ['https://tspec.org', 'http://localhost:3000'],
    securityDefinitions: {
      jwt: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
  },
  debug: false,
  ignoreErrors: true,
  port: 3000,
  proxyHost: 'https://tspec.org',
};

initTspecServer(options);
```
