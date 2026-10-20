import esbuild from "esbuild";
import process from "node:process";

const watch = process.argv.includes("--watch");
const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  platform: "node",
  target: "es2022",
  // @electron/remote must never be bundled: the plugin uses the instance
  // Obsidian attaches to the Electron module (see obsidianRemote in main.ts),
  // and a bundled copy would run a second callback registry beside it.
  external: ["obsidian", "electron", "@electron/remote"],
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  logLevel: "info"
});

if (watch) {
  await context.watch();
  console.log("Watching for changes...");
} else {
  await context.rebuild();
  await context.dispose();
}
