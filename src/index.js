import puppeteer from '@cloudflare/puppeteer';

export default {
  async fetch(request, env) {
    const url = new URL(request.url).searchParams.get('url');
    if (!url) return Response.json({ error: "請提供 ?url= 參數" }, { status: 400 });

    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    try {
      await page.goto(url, { waitUntil: 'networkidle2' });
      const text = await page.evaluate(() => document.body.innerText.slice(0, 1000));
      
      // AI 向量化
      const { data } = await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [text] });

      // 存入 Vectorize
      await env.VECTOR_INDEX.upsert([{
        id: crypto.randomUUID(),
        values: data[0],
        metadata: { url }
      }]);

      return Response.json({ success: true, message: "資料已存入 js-playground" });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    } finally {
      await browser.close();
    }
  }
};
