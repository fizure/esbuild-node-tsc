#!/usr/bin/env node

import ts, { BuildOptions } from "typescript";
import { watch } from "chokidar";
import { build } from "esbuild";
import cpy from "cpy";
import path from "path";
import rimraf from "rimraf";
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { Argv } from 'yargs';
import { Config, readUserConfig } from "./config";

const cwd = process.cwd();
const { argv } = yargs(hideBin(process.argv));

function getTSConfig(_tsConfigFile = "tsconfig.json") {
  const tsConfigFile = ts.findConfigFile(cwd, ts.sys.fileExists, _tsConfigFile);
  if (!tsConfigFile) {
    throw new Error(`tsconfig.json not found in the current directory! ${cwd}`);
  }
  const configFile = ts.readConfigFile(tsConfigFile, ts.sys.readFile);
  const tsConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    cwd
  );
  return { tsConfig, tsConfigFile };
}

type TSConfig = ReturnType<typeof getTSConfig>["tsConfig"];

function esBuildSourceMapOptions(tsConfig: TSConfig) {
  const { sourceMap, inlineSources, inlineSourceMap } = tsConfig.options;

  // inlineSources requires either inlineSourceMap or sourceMap
  if (inlineSources && !inlineSourceMap && !sourceMap) {
    return false;
  }

  // Mutually exclusive in tsconfig
  if (sourceMap && inlineSourceMap) {
    return false;
  }

  if (inlineSourceMap) {
    return "inline";
  }

  return sourceMap;
}

function getBuildMetadata(userConfig: Config) {
  const { tsConfig, tsConfigFile } = getTSConfig(userConfig.tsConfigFile);

  const outDir = userConfig.outDir || tsConfig.options.outDir || "dist";

  const esbuildEntryPoints = userConfig.esbuild?.entryPoints || [];
  const srcFiles = [...tsConfig.fileNames, ...esbuildEntryPoints];
  const sourcemap = esBuildSourceMapOptions(tsConfig);
  const target =
    userConfig.esbuild?.target ||
    tsConfig?.raw?.compilerOptions?.target ||
    "es6";
  const minify = userConfig.esbuild?.minify || false;
  const plugins = userConfig.esbuild?.plugins || [];

  const esbuildOptions: BuildOptions = {
    outdir: outDir,
    entryPoints: srcFiles,
    sourcemap,
    target,
    minify,
    plugins,
    tsconfig: tsConfigFile,
  };

  const assetPatterns = userConfig.assets?.filePatterns || ["**"];

  const assetsOptions = {
    baseDir: userConfig.assets?.baseDir || "src",
    outDir: outDir,
    patterns: [...assetPatterns, `!**/*.{ts,js,tsx,jsx}`],
  };

  return { outDir, esbuildOptions, assetsOptions };
}

async function buildSourceFiles(esbuildOptions: Partial<BuildOptions>) {
  return await build({
    ...esbuildOptions,
    bundle: false,
    format: "cjs",
    platform: "node",
  });
}

type AssetsOptions = { baseDir: string; outDir: string; patterns: string[] };

async function copyNonSourceFiles({
  baseDir,
  outDir,
  patterns,
}: AssetsOptions) {
  const relativeOutDir = path.relative(baseDir, outDir);
  return await cpy(patterns, relativeOutDir, {
    cwd: baseDir,
    parents: true,
  });
}

async function normalBuild(outDir: string, esbuildOptions: Partial<BuildOptions>, assetsOptions: AssetsOptions) {
  rimraf.sync(outDir);

  return await Promise.all([
    buildSourceFiles(esbuildOptions),
    copyNonSourceFiles(assetsOptions),
  ]);
}

async function watchBuild(outDir: string, esbuildOptions: Partial<BuildOptions>, assetsOptions: AssetsOptions) {
  rimraf.sync(outDir);

  console.time('Initial build in');
  const builder = await build({
    ...esbuildOptions,
    bundle: false,
    format: "cjs",
    platform: "node",
    incremental: true,
  });
  console.timeEnd('Initial build in');
  console.time('Initial assets copied in');
  await copyNonSourceFiles(assetsOptions);
  console.timeEnd('Initial assets copied in');

  const ignored = outDir+'/**';
  console.log({ ignored });

  const assetWatcher = watch(assetsOptions.patterns, { ignored });
  assetWatcher.on('change', async (...params) => {
    console.log({ params });
    console.time("Assets copied in");
    await copyNonSourceFiles(assetsOptions);
    console.timeEnd("Assets copied in");
  });

  const codeWatcher = watch(esbuildOptions.entryPoints as string[], { ignored: ignored });
  codeWatcher.on('change', async (...params) => {
    console.log({ params });
    console.time("Rebuilt in");
    await builder.rebuild();
    console.timeEnd("Rebuilt in");
  });

  // process.on('SIGKILL', () => {
  //   assetWatcher.close();
  //   codeWatcher.close();
  //   builder.rebuild.dispose();
  // });
}

async function main() {
  const configFilename = <string>argv?.config || 'etsc.config.js';

  const config = await readUserConfig(path.resolve(cwd, configFilename));

  const { outDir, esbuildOptions, assetsOptions } = getBuildMetadata(config);

  if (config.watch) {
    return await watchBuild(outDir, esbuildOptions, assetsOptions);
  } else {
    console.time("Built in");
    const result = await normalBuild(outDir, esbuildOptions, assetsOptions);
    console.timeEnd("Built in");
    return result;
  }
}


main()
  .then(() => {
    // process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
