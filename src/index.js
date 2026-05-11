import puppeteer from '@cloudflare/puppeteer';

export default {
  async fetch(request, env) {
    const url = new URL(request.url).searchParams.get('url');
    if (!url) return new Response("請提供 ?url= 參數", { status: 400 });

    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    try {
      await page.goto(url, { waitUntil: 'networkidle2' });
      const text = await page.evaluate(() => document.body.innerText.slice(0, 1000));
      
      // 使用 1024 維度模型
      const { data } = await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [text] });

      // 存入 Vectorize
      await env.VECTOR_INDEX.upsert([{
        id: crypto.randomUUID(),
        values: data[0],
        metadata: { url }
      }]);

      return Response.json({ success: true, message: "成功存入 js-playground Index！" });
    } catch (e) {
      // 如果是因為 Index 不存在導致的錯誤，這裡會顯示
      return new Response("錯誤: " + e.message, { status: 500 });
    } finally {
      await browser.close();
    }
  }
};
