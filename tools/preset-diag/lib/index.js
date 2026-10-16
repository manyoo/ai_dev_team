import { writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "preset-diag";
export const inject = ["agentPresets"];

/** Package root; a relative `out` resolves here, so the bundle works from any install location. */
const BUNDLE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Dump the live preset roster (with broken reasons) and the composition inventory. */
export async function apply(ctx, config) {
  const out = config.out === undefined || isAbsolute(config.out) ? config.out : resolve(BUNDLE_DIR, config.out);
  const run = async (label) => {
    try {
      const list = await ctx.agentPresets.list();
      const inventory = typeof ctx.agentPresets.compositionInventory === "function"
        ? await ctx.agentPresets.compositionInventory()
        : [];
      writeFileSync(out, JSON.stringify({ label, at: new Date().toISOString(), list, inventory }, null, 2));
    } catch (error) {
      writeFileSync(out, JSON.stringify({ label, error: String((error && error.stack) || error) }, null, 2));
    }
  };
  for (const delay of [1200, 4000, 9000]) {
    const timer = setTimeout(() => void run(`t+${delay}ms`), delay);
    ctx.effect(() => () => clearTimeout(timer));
  }
}
