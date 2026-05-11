import puppeteer from '@cloudflare/puppeteer';

export default {
  async fetch(request, env) {
    const url = new URL(request.url).searchParams.get('url');
    if (!url) return new Response("Missing URL", { status: 400 });

    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    try {
      await page.goto(url);
      const text = await page.evaluate(() => document.body.innerText.slice(0, 1000));
      
      // 1. 生成 1024 維向量
      const { data } = await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [text] });

      // 2. 存入你的 js-playground
      await env.VECTOR_INDEX.upsert([{
        id: crypto.randomUUID(),
        values: data[0],
        metadata: { url }
      }]);

      return Response.json({ success: true, message: "已經存入你的 js-playground Vectorize!" });
    } catch (e) {
      return new Response(e.message, { status: 500 });
    } finally {
      await browser.close();
    }
  }
};
