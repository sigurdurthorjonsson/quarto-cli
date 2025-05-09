/*
 * engine.ts
 *
 * Copyright (C) 2020-2022 Posit Software, PBC
 */

import { extname, join } from "../deno_ral/path.ts";

import * as ld from "../core/lodash.ts";

import {
  partitionYamlFrontMatter,
  readYamlFromMarkdown,
} from "../core/yaml.ts";
import { dirAndStem } from "../core/path.ts";

import { metadataAsFormat } from "../config/metadata.ts";
import { kBaseFormat, kEngine } from "../config/constants.ts";

import { knitrEngine } from "./rmd.ts";
import { jupyterEngine } from "./jupyter/jupyter.ts";
import { kMdExtensions, markdownEngine } from "./markdown.ts";
import { ExecutionEngine, kQmdExtensions } from "./types.ts";
import { languagesInMarkdown } from "./engine-shared.ts";
import { languages as handlerLanguages } from "../core/handlers/base.ts";
import { RenderContext, RenderFlags } from "../command/render/types.ts";
import { mergeConfigs } from "../core/config.ts";
import { ProjectContext } from "../project/types.ts";
import { pandocBuiltInFormats } from "../core/pandoc/pandoc-formats.ts";
import { gitignoreEntries } from "../project/project-gitignore.ts";
import { juliaEngine } from "./julia.ts";
import { ensureFileInformationCache } from "../project/project-shared.ts";
import { Command } from "cliffy/command/mod.ts";

const kEngines: Map<string, ExecutionEngine> = new Map();

export function executionEngines(): ExecutionEngine[] {
  return [...kEngines.values()];
}

export function executionEngine(name: string) {
  return kEngines.get(name);
}

for (
  const engine of [knitrEngine, jupyterEngine, markdownEngine, juliaEngine]
) {
  registerExecutionEngine(engine);
}

export function registerExecutionEngine(engine: ExecutionEngine) {
  if (kEngines.has(engine.name)) {
    throw new Error(`Execution engine ${engine.name} already registered`);
  }
  kEngines.set(engine.name, engine);
}

export function executionEngineKeepMd(context: RenderContext) {
  const { input } = context.target;
  const baseFormat = context.format.identifier[kBaseFormat] || "html";
  const keepSuffix = `.${baseFormat}.md`;
  if (!input.endsWith(keepSuffix)) {
    const [dir, stem] = dirAndStem(input);
    return join(dir, stem + keepSuffix);
  }
}

// for the project crawl
export function executionEngineIntermediateFiles(
  engine: ExecutionEngine,
  input: string,
) {
  // all files of the form e.g. .html.md or -html.md are interemediate
  const files: string[] = [];
  const [dir, stem] = dirAndStem(input);
  files.push(
    ...pandocBuiltInFormats()
      .flatMap((format) => [`-${format}.md`, `.${format}.md`])
      .map((suffix) => join(dir, stem + suffix)),
  );

  // additional engine-specific intermediates (e.g. .ipynb for jupyter)
  const engineKeepFiles = engine.intermediateFiles
    ? engine.intermediateFiles(input)
    : undefined;
  if (engineKeepFiles) {
    return files.concat(engineKeepFiles);
  } else {
    return files;
  }
}

export function engineValidExtensions(): string[] {
  return ld.uniq(
    executionEngines().flatMap((engine) => engine.validExtensions()),
  );
}

export function markdownExecutionEngine(
  markdown: string,
  reorderedEngines: Map<string, ExecutionEngine>,
  flags?: RenderFlags,
) {
  // read yaml and see if the engine is declared in yaml
  // (note that if the file were a non text-file like ipynb
  //  it would have already been claimed via extension)
  const result = partitionYamlFrontMatter(markdown);
  if (result) {
    let yaml = readYamlFromMarkdown(result.yaml);
    if (yaml) {
      // merge in command line fags
      yaml = mergeConfigs(yaml, flags?.metadata);
      for (const [_, engine] of reorderedEngines) {
        if (yaml[engine.name]) {
          return engine;
        }
        const format = metadataAsFormat(yaml);
        if (format.execute?.[kEngine] === engine.name) {
          return engine;
        }
      }
    }
  }

  // if there are languages see if any engines want to claim them
  const languages = languagesInMarkdown(markdown);

  // see if there is an engine that claims this language
  for (const language of languages) {
    for (const [_, engine] of reorderedEngines) {
      if (engine.claimsLanguage(language)) {
        return engine;
      }
    }
  }

  const handlerLanguagesVal = handlerLanguages();
  // if there is a non-cell handler language then this must be jupyter
  for (const language of languages) {
    if (language !== "ojs" && !handlerLanguagesVal.includes(language)) {
      return jupyterEngine;
    }
  }

  // if there is no computational engine discovered then bind
  // to the markdown engine;
  return markdownEngine;
}

function reorderEngines(project: ProjectContext) {
  const userSpecifiedOrder: string[] =
    project.config?.engines as string[] | undefined ?? [];

  for (const key of userSpecifiedOrder) {
    if (!kEngines.has(key)) {
      throw new Error(
        `'${key}' was specified in the list of engines in the project settings but it is not a valid engine. Available engines are ${
          Array.from(kEngines.keys()).join(", ")
        }`,
      );
    }
  }

  const reorderedEngines = new Map<string, ExecutionEngine>();

  // Add keys in the order of userSpecifiedOrder first
  for (const key of userSpecifiedOrder) {
    reorderedEngines.set(key, kEngines.get(key)!); // Non-null assertion since we verified the keys are in the map
  }

  // Add the rest of the keys from the original map
  for (const [key, value] of kEngines) {
    if (!reorderedEngines.has(key)) {
      reorderedEngines.set(key, value);
    }
  }

  return reorderedEngines;
}

export async function fileExecutionEngine(
  file: string,
  flags: RenderFlags | undefined,
  project: ProjectContext,
) {
  // get the extension and validate that it can be handled by at least one of our engines
  const ext = extname(file).toLowerCase();
  if (
    !(executionEngines().some((engine) =>
      engine.validExtensions().includes(ext)
    ))
  ) {
    return undefined;
  }

  const reorderedEngines = reorderEngines(project);

  // try to find an engine that claims this extension outright
  for (const [_, engine] of reorderedEngines) {
    if (engine.claimsFile(file, ext)) {
      return engine;
    }
  }

  // if we were passed a transformed markdown, use that for the text instead
  // of the contents of the file.
  if (kMdExtensions.includes(ext) || kQmdExtensions.includes(ext)) {
    const markdown = await project.resolveFullMarkdownForFile(undefined, file);
    // https://github.com/quarto-dev/quarto-cli/issues/6825
    // In case the YAML _parsing_ fails, we need to annotate the error
    // with the filename so that the user knows which file is the problem.
    try {
      return markdownExecutionEngine(
        markdown ? markdown.value : Deno.readTextFileSync(file),
        reorderedEngines,
        flags,
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error.name === "YAMLError") {
        error.message = `${file}:\n${error.message}`;
      }
      throw error;
    }
  } else {
    return undefined;
  }
}

export async function fileExecutionEngineAndTarget(
  file: string,
  flags: RenderFlags | undefined,
  // markdown: MappedString | undefined,
  project: ProjectContext,
) {
  const cached = ensureFileInformationCache(project, file);
  if (cached && cached.engine && cached.target) {
    return { engine: cached.engine, target: cached.target };
  }

  const engine = await fileExecutionEngine(file, flags, project);
  if (!engine) {
    throw new Error("Can't determine execution engine for " + file);
  }
  const markdown = await project.resolveFullMarkdownForFile(engine, file);

  const target = await engine.target(file, flags?.quiet, markdown, project);
  if (!target) {
    throw new Error("Can't determine execution target for " + file);
  }

  cached.engine = engine;
  cached.target = target;
  const result = { engine, target };
  return result;
}

export function engineIgnoreDirs() {
  const ignoreDirs: string[] = ["node_modules"];
  executionEngines().forEach((engine) => {
    if (engine && engine.ignoreDirs) {
      const ignores = engine.ignoreDirs();
      if (ignores) {
        ignoreDirs.push(...ignores);
      }
    }
  });
  return ignoreDirs;
}

export function engineIgnoreGlobs() {
  return engineIgnoreDirs().map((ignore) => `**/${ignore}/**`);
}

export function projectIgnoreGlobs(dir: string) {
  return engineIgnoreGlobs().concat(
    gitignoreEntries(dir).map((ignore) => `**/${ignore}**`),
  );
}

export const engineCommand = new Command()
  .name("engine")
  .description(
    `Access functionality specific to quarto's different rendering engines.`,
  )
  .action(() => {
    engineCommand.showHelp();
    Deno.exit(1);
  });

kEngines.forEach((engine, name) => {
  if (engine.populateCommand) {
    const engineSubcommand = new Command();
    // fill in some default behavior for each engine command
    engineSubcommand
      .description(
        `Access functionality specific to the ${name} rendering engine.`,
      )
      .action(() => {
        engineSubcommand.showHelp();
        Deno.exit(1);
      });
    engine.populateCommand(engineSubcommand);
    engineCommand.command(name, engineSubcommand);
  }
});
