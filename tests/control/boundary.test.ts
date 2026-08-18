import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";

// docs/design.md §2 makes this the load-bearing constraint of the whole control plane:
//
//   "control/ must not import worker/ or any Copilot-specific module."
//
// It buys three things — the control plane can be exercised end-to-end with no tunnel and no Copilot
// subscription; swapping the transport later rewrites one folder instead of the plane; and worker/
// never has to know the shape of ~/.claude. None of that survives a single convenient import, and a
// convention nobody can mechanically check is a convention that decays. So it is a test.

const CONTROL_ROOT = resolve(__dirname, "../../src/control");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...sourceFiles(abs));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(abs);
  }
  return out;
}

// Every `from "..."` / `import("...")` specifier in a file.
//
// Comments are stripped first: this codebase explains itself at length, and prose like
// `indistinguishable from "cc-fleet never ran here"` otherwise reads as an import and fails the scan.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // `[^:]` keeps `http://…` inside a string literal from being mistaken for a comment.
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}
function importsOf(file: string): string[] {
  const src = stripComments(readFileSync(file, "utf8"));
  const specifiers: string[] = [];
  for (const m of src.matchAll(/\bfrom\s+["']([^"']+)["']/g)) specifiers.push(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) specifiers.push(m[1]);
  return specifiers;
}

describe("control/ module boundary", () => {
  const files = sourceFiles(CONTROL_ROOT);

  it("has source files to check (guards against the scan silently finding nothing)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("never imports worker/, supervisor/, providers/, tui/, cli/ or daemon/", () => {
    const forbidden = /(^|\/)(worker|supervisor|providers|tui|cli|daemon)\//;
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of importsOf(file)) {
        if (spec.startsWith(".") && forbidden.test(spec)) {
          violations.push(`${relative(CONTROL_ROOT, file)} imports ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps every relative import inside src/control/", () => {
    // Stronger and simpler than an allow-list of forbidden folders: control/ depends on nothing else
    // in src/ at all, so any escape is a violation regardless of what it points at.
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of importsOf(file)) {
        if (!spec.startsWith(".")) continue;
        const target = resolve(dirname(file), spec);
        if (!(target + sep).startsWith(CONTROL_ROOT + sep)) {
          violations.push(`${relative(CONTROL_ROOT, file)} imports ${spec} (outside src/control)`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("depends only on runtime packages that carry no Copilot/Anthropic coupling", () => {
    // A bare specifier can smuggle the coupling back in (e.g. the Anthropic SDK). Keep the surface
    // explicit so adding one is a deliberate, reviewed act.
    const allowed = new Set(["express", "zod"]);
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of importsOf(file)) {
        if (spec.startsWith(".") || spec.startsWith("node:")) continue;
        if (!allowed.has(spec)) violations.push(`${relative(CONTROL_ROOT, file)} imports ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
