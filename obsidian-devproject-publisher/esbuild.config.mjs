import {build} from "esbuild";
await build({entryPoints:["src/main.ts"],bundle:true,external:["obsidian"],format:"cjs",platform:"browser",target:"es2020",outfile:"main.js",sourcemap:false,legalComments:"eof"});
await build({entryPoints:["src/exporter.ts","src/sanitizer.ts","src/api.ts","src/settings.ts"],outdir:"tests/bundle",bundle:true,external:["obsidian"],format:"cjs",platform:"browser",target:"es2020"});
