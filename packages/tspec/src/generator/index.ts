import fs from 'fs/promises';
import { dirname } from 'path';

import debug from 'debug';
import glob from 'glob';
import { OpenAPIV3 } from 'openapi-types';
// eslint-disable-next-line import/no-extraneous-dependencies
import ts from 'typescript';
import * as TJS from 'typescript-json-schema';

import { Tspec } from '../types/tspec';
import { assertIsDefined, isDefined } from '../utils/types';

import { exec } from 'child_process';

import { getOpenapiPaths } from './openapiGenerator';
import { convertToOpenapiSchemas } from './openapiSchemaConverter';
import { SchemaMapping } from './types';
import { getTspecConfigFromConfigFile, isTspecFileConfigAvailable } from './config';
import { mergeDeep } from '../utils/merge';

export const DEBUG = debug('tspec');

const isNodeExported = (node: ts.Node): boolean => (
  // eslint-disable-next-line no-bitwise
  (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0
  || (!!node.parent && node.parent.kind === ts.SyntaxKind.SourceFile)
);

const getMappingOfJoiJsonSchema = (p: ts.Program) => {
  const entryPoints = p
      .getRootFileNames()
      .map((entryPointName) => p.getSourceFile(entryPointName)).filter(isDefined);

  const JsonSchemaMap: Map<string, string> = new Map();
  const filenameMap: Map<string, string> = new Map();

  entryPoints.forEach((srcFile) => {
    srcFile.forEachChild((node) => {

      if (!isNodeExported(node)){
        return;
      }

      // We expect following statements
      // e.g. const JoiSchemaJson = parse(JoiSchema);
      if(!(node as any).declarationList || !(node as any).flowNode?.node){
        return;
      }

      const declared = (node as any).declarationList.declarations.at(0);
      const initial = declared.initializer
      if(initial.expression?.escapedText !== 'parse'){
        return;
      }

      const name = declared.name.escapedText;
      const argumentName = initial.arguments.at(0).escapedText;
      JsonSchemaMap.set(argumentName, name);
      filenameMap.set(name, srcFile.fileName)
      console.log("declare", declared)
      console.log("init", initial)
    })
  })
  return {JsonSchemaMap, filenameMap};
}

const getMappingOfJoiExtractTypeSignatures = (p: ts.Program) => {
  const entryPoints = p
      .getRootFileNames()
      .map((entryPointName) => p.getSourceFile(entryPointName)).filter(isDefined);

  const namesMap: Map<string, string> = new Map();

  entryPoints.forEach((srcFile) => {
    srcFile.forEachChild((node) => {


      if (!isNodeExported(node)) {
        return;
      }
      // Mapping `interface XXX extends Joi.extractType<typeof XXXSchema>`

      // NOTE(hyeonseong): typescript 5.0 changed node kind of type alias declaration.
      // if (
      //   !ts.isTypeAliasDeclaration(node)
      //   || !ts.isTypeReferenceNode(node.type)
      // ) {
      //   return;
      // }

      if ((node as any).heritageClauses?.at(0)?.types.at(0).expression?.name?.escapedText !== 'extractType') {
        return;
      }
      const name = (node as any).name.escapedText as string;
      if (namesMap.has(name)) {
        throw new Error(`Duplicate name: ${name}`);
      }

      const argument = (node as any).heritageClauses?.at(0)?.types.at(0)?.typeArguments?.at(0)
      if(!argument){
        return;
      }
      const value = argument.exprName.escapedText;
      namesMap.set(name, value)
    });
  });

  return namesMap;
};

const getTspecSignatures = (p: ts.Program) => {
  const entryPoints = p
    .getRootFileNames()
    .map((entryPointName) => p.getSourceFile(entryPointName)).filter(isDefined);

  const names: string[] = [];
  entryPoints.forEach((srcFile) => {
    srcFile.forEachChild((node) => {
      if (!isNodeExported(node)) {
        return;
      }

      // NOTE(hyeonseong): typescript 5.0 changed node kind of type alias declaration.
      // if (
      //   !ts.isTypeAliasDeclaration(node)
      //   || !ts.isTypeReferenceNode(node.type)
      // ) {
      //   return;
      // }
      if ((node as any).type?.typeName?.right?.escapedText !== 'DefineApiSpec') {
        return;
      }
      const name = (node as any).name.escapedText as string;
      if (names.includes(name)) {
        throw new Error(`Duplicate name: ${name}`);
      }
      names.push(name);
    });
  });

  return names;
};

const getCompilerOptions = (tsconfigPath: string): ts.CompilerOptions => {
  const { config, error } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (error) {
    throw new Error(error.messageText as string);
  }
  return {
    ...config.compilerOptions,
    noEmit: true,
  };
};

const getDefaultProgramFiles = (compilerOptions: ts.CompilerOptions) => {
  const { rootDir, rootDirs } = compilerOptions;
  const globs = [rootDir, ...(rootDirs || [])].filter(isDefined)
    .flatMap((r) => [`${r}/*.ts`, `${r}/**/*.ts`]);
  if (globs.length === 0) {
    return ['**/*.ts'];
  }
  return globs;
};

const getProgramFiles = (compilerOptions: ts.CompilerOptions, specPathGlobs?: string[]) => {
  const srcGlobs = specPathGlobs || getDefaultProgramFiles(compilerOptions);
  const programFils = [...new Set(srcGlobs.flatMap((g) => glob.sync(g, {
    ignore: ['**/node_modules/**'],
  })))];
  DEBUG({ programFils });
  return programFils;
};

/**
 * 제대로 동작하지 않는 케이스..?
 * 1. Partial of Record
 * export type BlockRegions = Partial<Record<'es' | 'en', { blockAt: string }>>;
 */
const getOpenapiSchemas = async (
  tsconfigPath: string,
  specPathGlobs?: string[],
  ignoreErrors?: boolean,
) => {
  const compilerOptions = getCompilerOptions(tsconfigPath);
  DEBUG({ compilerOptions });
  const files = getProgramFiles(compilerOptions, specPathGlobs);
  DEBUG({ files });
  const program = TJS.getProgramFromFiles(files, compilerOptions);

  const tjsSettings: TJS.PartialArgs = {
    required: true,
    noExtraProps: true,
    strictNullChecks: true,
    ignoreErrors: ignoreErrors || true,
    esModuleInterop: compilerOptions.esModuleInterop,
    constAsEnum: true,
    // rejectDateType: true,
    validationKeywords: [
      /** NOTE: JSON schema keywords. see https://swagger.io/docs/specification/data-models/keywords/ */
      'title', 'pattern',
      'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
      'minLength', 'maxLength', 'pattern',
      'minItems', 'maxItems', 'uniqueItems',
      'minProperties', 'maxProperties',
      /** NOTE: These keywords are supported with minor differences */
      /** 'type', */ 'format', 'description', 'default',
      /** NOTE: Additional keywords */
      'deprecated', 'discriminator', 'example', 'externalDocs', 'nullable', /** 'readOnly', 'writeOnly', */
      /** NOTE: parameter validation. see https://swagger.io/docs/specification/describing-parameters/ */
      'allowReserved', 'style', 'form', 'allowEmptyValue', 'explode',
      /** NOTE: media type. see https://swagger.io/docs/specification/media-types/ */
      'mediaType',
    ],
  };
  DEBUG({ tjsSettings });
  const generator = TJS.buildGenerator(program, tjsSettings);
  assertIsDefined(generator);

  const tspecSymbols = getTspecSignatures(program as ts.Program);
  DEBUG({ tspecSymbols });
  const { definitions: jsonSchemas } = generator.getSchemaForSymbols(tspecSymbols);
  assertIsDefined(jsonSchemas);
  DEBUG({ schemaKeys: Object.keys(jsonSchemas) });
  const openapiSchemas = await convertToOpenapiSchemas(jsonSchemas);

  const JoiObjectMap = getMappingOfJoiExtractTypeSignatures(program as ts.Program);
  const {JsonSchemaMap, filenameMap} = getMappingOfJoiJsonSchema(program as ts.Program)
  // Example
  //  Map(1) { 'ReqSearchSchool' => 'ReqSearchSchoolScheme' }
  //  Map(1) { 'ReqSearchSchoolScheme' => 'ReqSearchSchoolSchemeJson' }
  DEBUG(JoiObjectMap)
  DEBUG(JsonSchemaMap)
  DEBUG(filenameMap)

  return { openapiSchemas, tspecSymbols, JoiObjectMap, JsonSchemaMap, filenameMap };
};

const getOpenapiSchemasOnly = (openapiSchemas: SchemaMapping, tspecSymbols: string[]) => {
  const tspecPathSchemas = tspecSymbols.flatMap((tspecSymbol) => {
    const paths = openapiSchemas[tspecSymbol].properties || {};
    DEBUG({ tspecSymbol, paths });
    return Object.keys(paths).map((path) => {
      const obj = paths[path];
      if ('$ref' in obj) {
        const [, schemaName] = obj.$ref.split('#/components/schemas/');
        return schemaName;
      }
      return undefined;
    });
  });

  const isTspecSchema = (key: string) => (
    tspecSymbols.includes(key) || tspecPathSchemas.includes(key)
  )

  const omitPathSchemaFields = (schema: OpenAPIV3.SchemaObject & { mediaType?: string }) => {
    const { mediaType, ...rest } = schema;
    return rest;
  }

  return Object.fromEntries(
    Object.entries(openapiSchemas)
      .filter(([key]) => !isTspecSchema(key))
      .map(([key, value]) => [key, omitPathSchemaFields(value)]),
  );
};

export const defaultGenerateParams = {
  specPathGlobs: ['**/*.ts'],
  tsconfigPath: 'tsconfig.json',
  configPath: 'tspec.config.json',
  specVersion: 3,
  openapi: {
    title: 'Tspec API',
    version: '0.0.1',
    description: '',
  },
  debug: false,
  ignoreErrors: true,
  applyScript: true
} satisfies Tspec.GenerateParams;

const getGenerateTspecParams = async (
  overrideParams: Tspec.GenerateParams = {},
): Promise<Tspec.GenerateParams> => {
  const configPath = overrideParams.configPath || defaultGenerateParams.configPath;

  if (await isTspecFileConfigAvailable(configPath)) {
    const fileConfig = await getTspecConfigFromConfigFile(configPath);
    return mergeDeep(mergeDeep(defaultGenerateParams, fileConfig), overrideParams);
  }

  return mergeDeep(defaultGenerateParams, overrideParams);
};

const createScript = async (
  JoiObjectMap: Map<string, string>, 
  JsonSchemaMap: Map<string, string>, 
  fileNameMap: Map<string,string>,
  filePath: string,
) => {
  const importFiles: string [] = [];
  const replaceMap: Map<string, string> = new Map();
  DEBUG(JoiObjectMap)

  JoiObjectMap.forEach((val, key) => {
    const ret = JsonSchemaMap.get(val);
    DEBUG(ret)
    DEBUG(JsonSchemaMap)
    if(ret){
      importFiles.push(ret);
      replaceMap.set(ret, key)
    }
  })
  
  const importStr = importFiles.reduce((prev, cur) => {
    return prev + `import {${cur}}from '${fileNameMap.get(cur)}' \n`
  }, '')
  
  DEBUG(importStr)

  const funcStr = `
  const json = JSON.parse(fs.readFileSync('${filePath}', 'utf-8'))
  `


  const jsonStr = importFiles.reduce((prev, cur) => {
    return prev + `json.components.schemas['${replaceMap.get(cur)}'] = ${cur}\n`
  },'')

  


  await fs.writeFile("script.ts", 
    `import fs from 'fs' \n` +
    importStr +
    funcStr +
    jsonStr +
    `fs.writeFileSync('${filePath}', JSON.stringify(json, undefined, '\t'));`
  )

}

export const createJsonFile = async (filePath: string, json: any) => {
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(json, null, 2));
}

export const applyScript = () => {
    exec('npx tsx script.ts')
    return;
}

export const generateTspec = async (
  generateParams: Tspec.GenerateParams = {},
): Promise<OpenAPIV3.Document> => {
  const params = await getGenerateTspecParams(generateParams);

  const {
    openapiSchemas, tspecSymbols, JoiObjectMap, JsonSchemaMap, filenameMap
  } = await getOpenapiSchemas(
    params.tsconfigPath || 'tsconfig.json',
    params.specPathGlobs,
    params.ignoreErrors,
  );

  const paths = getOpenapiPaths(openapiSchemas, tspecSymbols);
  const schemas = getOpenapiSchemasOnly(openapiSchemas, tspecSymbols);

  const openapi: OpenAPIV3.Document = {
    info: {
      title: params.openapi?.title || 'Tspec API',
      version: params.openapi?.version || '0.0.1',
      description: params.openapi?.description || '',
    },
    openapi: (params.specVersion === 3 && '3.0.3') || '3.0.3',
    paths,
    components: {
      schemas,
      securitySchemes: params.openapi?.securityDefinitions,
    },
    servers: params.openapi?.servers,
  };

  if (params.outputPath) {
    await createJsonFile(params.outputPath, openapi);
    await createScript(JoiObjectMap, JsonSchemaMap, filenameMap, params.outputPath)
    if (params.applyScript){
      applyScript();
    }
  }

  return openapi;
};
