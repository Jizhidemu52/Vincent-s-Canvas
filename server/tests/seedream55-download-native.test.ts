import { expect, test } from "bun:test";

test("layer original download falls back only across validated public DNS addresses", async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { downloadSeedream55Original } from ${JSON.stringify(new URL("../src/seedream55-download-worker.mjs", import.meta.url).href)};
    const addresses = [{address:'8.8.8.8',family:4},{address:'1.1.1.1',family:4},{address:'9.9.9.9',family:4}];
    const resolver = async () => addresses;
    const bytes = Buffer.from([137,80,78,71,13,10,26,10]);
    const calls = [];
    const result = await downloadSeedream55Original('https://image.example/layer.png', {resolver, request:async (url,address,options)=>{
      calls.push(address.address); assert.equal(url.hostname,'image.example');
      assert.equal(options.maxBytes,67108864); assert.equal(options.kind,'image');
      assert.equal(options.signal.aborted,false); assert.equal(options.headers,undefined); assert.equal(options.connectTimeoutMs,10000);
      if(calls.length < 3) throw Object.assign(new Error('transport'),{code:calls.length===1?'ETIMEDOUT':'ECONNRESET'});
      return {status:200,bytes};
    }});
    assert.deepEqual(calls,addresses.map(value=>value.address)); assert.equal(result,bytes);
    for(const code of ['UNSUPPORTED_TYPE','BODY_TOO_LARGE','REMOTE_HTTP_ERROR','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID']){
      let count=0;
      await assert.rejects(downloadSeedream55Original('https://image.example/layer.png',{resolver,request:async()=>{count++;throw Object.assign(new Error(code),{code});}}));
      assert.equal(count,1);
    }
    let redirects=0;
    await assert.rejects(downloadSeedream55Original('https://image.example/layer.png',{resolver,request:async()=>{redirects++;return {status:302,bytes};}}),/Redirects/);
    assert.equal(redirects,1);
    let unsafeRequests=0;
    for(const address of ['127.0.0.1','169.254.169.254','10.0.0.1']){
      await assert.rejects(downloadSeedream55Original('https://image.example/layer.png',{resolver:async()=>[addresses[0],{address,family:4}],request:async()=>{unsafeRequests++;}}));
    }
    assert.equal(unsafeRequests,0);
    let bounded=0;
    await assert.rejects(downloadSeedream55Original('https://image.example/layer.png',{resolver:async()=>[...addresses,{address:'8.8.4.4',family:4}],request:async()=>{bounded++;throw Object.assign(new Error('transport'),{code:'ETIMEDOUT'});}}));
    assert.equal(bounded,3);
    console.log('public-address-fallback-ok');
  `;
  const child = Bun.spawn([Bun.which("node")!, "--input-type=module", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout.trim()).toBe("public-address-fallback-ok");
});

test("native connection deadline interrupts a stalled TLS handshake but keeps a slow connected body", async () => {
  const script = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import net from 'node:net';
    import { requestPinned } from ${JSON.stringify(new URL("../src/reference-import/public-fetch.mjs", import.meta.url).href)};
    const sockets=new Set();
    const hung=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    const slow=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'image/png'});res.flushHeaders();setTimeout(()=>res.end(Buffer.from('original')),100);});
    await Promise.all([new Promise(resolve=>hung.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>slow.listen(0,'127.0.0.1',resolve))]);
    const address={address:'127.0.0.1',family:4};
    try {
      const opts={kind:'image',maxBytes:1024,signal:AbortSignal.timeout(3000),connectTimeoutMs:30};
      await assert.rejects(requestPinned(new URL('https://native-fixture.example:'+hung.address().port),address,opts),{code:'ETIMEDOUT'});
      const result=await requestPinned(new URL('http://native-fixture.example:'+slow.address().port),address,opts);
      assert.equal(result.bytes.toString(),'original');
      console.log('connection-deadline-ok');
    } finally {for(const socket of sockets)socket.destroy();await Promise.all([new Promise(resolve=>hung.close(resolve)),new Promise(resolve=>slow.close(resolve))]);}
  `;
  const child = Bun.spawn([Bun.which("node")!, "--input-type=module", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout.trim()).toBe("connection-deadline-ok");
});
