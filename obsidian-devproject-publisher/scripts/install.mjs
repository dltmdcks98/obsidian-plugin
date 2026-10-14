import {readFile, mkdir, copyFile, stat, realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),index=args.indexOf('--destination');
if(index<0||!args[index+1])throw new Error('Use --destination <plugins-dir> --dry-run (or --approved-install after approval)');
if(!args.includes('--dry-run')&&!args.includes('--approved-install'))throw new Error('Explicit install approval flag required; default is no write');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
const destination=path.resolve(args[index+1],manifest.id);if(destination===root||destination.startsWith(root+path.sep))throw new Error('Cannot install into source tree');
for(const name of ['main.js','manifest.json','versions.json']){if(!(await stat(path.join(root,name))).isFile())throw new Error('Build artifact missing');}
if(args.includes('--dry-run')){console.log(JSON.stringify({dryRun:true,destination,files:['main.js','manifest.json','versions.json'],preserve:'data.json'}));}
else{await mkdir(destination,{recursive:true});if(await realpath(destination)!==destination)throw new Error('Symlink destination rejected');for(const name of ['main.js','manifest.json','versions.json'])await copyFile(path.join(root,name),path.join(destination,name));console.log('Copied built plugin only; restart/reload requires separate authorization.');}
