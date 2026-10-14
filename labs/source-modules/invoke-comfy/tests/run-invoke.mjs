import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceRoot=path.join(base,'sources/InvokeAI');
const src=path.join(sourceRoot,'invokeai/frontend/webv2/src');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8'}).trim();
if(sourceCommit!=='723d6007427b83cd3d2e2237a5db30da4e55c720')throw new Error('Unexpected InvokeAI source commit');
const evidenceDirectory=path.join(base,'reports');await fs.mkdir(evidenceDirectory,{recursive:true});
const served=new Map(),errors=[];
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/'){
      res.setHeader('content-type','text/html; charset=utf-8');
      return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>InvokeAI 原始模块实测</title><style>body{font:14px monospace;padding:25px;background:#f5f3ee;color:#26362a}pre{white-space:pre-wrap;line-height:1.6}</style><script type="importmap">{"imports":{"@workbench/":"/upstream/invoke/workbench/"}}</script><h1>InvokeAI 原始模块实测</h1><p>真实浏览器像素与源码模块；不运行 AI 模型。</p><pre id="result">执行中…</pre><script type="module" src="/tests/invoke-browser-tests.js"></script></html>');
    }
    if(url.pathname==='/tests/invoke-browser-tests.js'){res.setHeader('content-type','text/javascript');return res.end(await fs.readFile(path.join(base,'tests/invoke-browser-tests.js'),'utf8'));}
    if(url.pathname.startsWith('/upstream/invoke/')){
      let target=path.resolve(src,decodeURIComponent(url.pathname.slice('/upstream/invoke/'.length)));
      if(!target.startsWith(src+path.sep))throw new Error('outside source root');
      if(!path.extname(target))target+='.ts';
      const text=await fs.readFile(target,'utf8');
      served.set(path.relative(sourceRoot,target).replaceAll('\\','/'),createHash('sha256').update(text).digest('hex'));
      // Runtime type erasure only. No implementation statements are replaced or reimplemented.
      const javascript=target.endsWith('.ts')?stripTypeScriptTypes(text,{mode:'strip'}):text;
      res.setHeader('content-type','text/javascript');return res.end(javascript);
    }
    if(url.pathname==='/favicon.ico'){res.statusCode=204;return res.end();}
    res.statusCode=404;res.end('Not found');
  }catch(error){errors.push(error.message);res.statusCode=500;res.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || undefined});
try{
  const page=await browser.newPage({viewport:{width:1320,height:920}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>!!window.invokeResults,{},{timeout:20000});
  const result=await page.evaluate(()=>window.invokeResults);
  Object.assign(result,{repository:'https://github.com/invoke-ai/InvokeAI',commit:sourceCommit,sourceFiles:[...served].map(([file,sha256])=>({file,sha256})),pristine:execFileSync('git',['status','--porcelain'],{cwd:sourceRoot,encoding:'utf8'}).trim()==='',runtime:{node:process.version,browser:await browser.version()},transport:'Original TypeScript source served after Node native type erasure; import aliases resolve to upstream files. Shared Playwright drives Chromium; the full InvokeAI npm application is not installed.',pageErrors:errors,at:new Date().toISOString()});
  await fs.writeFile(path.join(evidenceDirectory,'invoke-results.json'),JSON.stringify(result,null,2));
  await page.screenshot({path:path.join(evidenceDirectory,'invoke-browser-results.png'),fullPage:true});
  console.log(JSON.stringify({commit:sourceCommit,summary:result.summary,invertEvidence:result.invertEvidence,pageErrors:errors,sourceFiles:result.sourceFiles.map(f=>f.file)},null,2));
  if(result.summary.failed||errors.length)process.exitCode=1;
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
