import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE || undefined});
const page = await browser.newPage({viewport:{width:1500,height:1000}});
const errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
try {
 await page.goto('http://127.0.0.1:4332/');
 await page.waitForFunction(()=>Boolean(window.editor), {timeout:30000});
 await page.waitForTimeout(1200);
 const state=await page.evaluate(()=>({title:document.title,nodes:window.editor.getCurrentPageShapes().map(s=>({id:s.id,type:s.type,node:s.props.node})),buttons:[...document.querySelectorAll('button')].map(b=>({text:b.innerText,title:b.title,aria:b.getAttribute('aria-label')}))}));
 await mkdir(new URL('../evidence/',import.meta.url),{recursive:true});
 await writeFile(new URL('../evidence/page-probe.json',import.meta.url),JSON.stringify({state,errors},null,2));
 await page.screenshot({path:fileURLToPath(new URL('../evidence/original-template-initial.png',import.meta.url))});
 console.log(JSON.stringify({state,errors},null,2));
} finally { await browser.close(); }
