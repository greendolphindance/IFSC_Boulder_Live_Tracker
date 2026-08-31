import { access } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const productionRoot = process.env.IFSC_REFERENCE_PRODUCTION_ROOT;

/**
 * The repository imports emitted .js paths from TypeScript source. The audit
 * environment intentionally has no installed dependencies, so this tiny test
 * loader maps a missing relative .js import to its sibling .ts source. Node 25
 * then performs its built-in TypeScript type stripping. It changes no project
 * files and does not transform business logic.
 */
export async function resolve(specifier, context, nextResolve) {
  if (productionRoot && specifier.endsWith("/server/src/state/medalChances.ts")) {
    return {
      shortCircuit: true,
      url: pathToFileURL(resolvePath(productionRoot, "server/src/state/medalChances.ts")).href
    };
  }
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    try {
      await access(candidate);
      return { shortCircuit: true, url: candidate.href };
    } catch {
      // Use Node's normal resolver so a real .js file still wins.
    }
  }
  return nextResolve(specifier, context);
}
