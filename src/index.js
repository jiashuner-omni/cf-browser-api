import puppeteer from '@cloudflare/puppeteer';

export default {
  async fetch(request, env) {
    const url = new URL(request.url).searchParams.get('url');

    // 1. 基礎檢查
    if (!url) {
      return new Response("請在網址後加上 ?url=https://example.com", { 
        status: 400,
        headers: { "content-type": "text/plain;charset=UTF-8" }
      });
    }

    let browser;
    try {
      // 2. 啟動瀏覽器
      browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();
      
      // 3. 爬取網頁內容
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      const pageTitle = await page.title();
      const textContent = await page.evaluate(() => document.body.innerText.slice(0, 1000));

      // 4. 使用 Workers AI 生成向量 (Embedding)
      // 使用 bge-large-en-v1.5 模型，輸出維度為 1024
      const { data: embeddings } = await env.AI.run('@cf/baai/bge-large-en-v1.5', {
        text: [textContent]
      });

      // 5. 存入 Vectorize 資料庫 (js-playground)
      const vectorId = crypto.randomUUID();
      await env.VECTOR_INDEX.upsert([{
        id: vectorId,
        values: embeddings[0],
        metadata: { url, title: pageTitle }
      }]);

      // 6. 截圖並存入 R2 儲存桶
      const screenshot = await page.screenshot();
      const fileName = `screenshot-${Date.now()}.png`;
      await env.BUCKET.put(fileName, screenshot);

      return Response.json({
        success: true,
        message: "已完成爬取、向量化與儲存",
        data: {
          title: pageTitle,
          vectorId: vectorId,
          r2File: fileName,
          indexName: "js-playground"
        }
      });

    } catch (err) {
      return Response.json({ success: false, error: err.message }, { status: 500 });
    } finally {
      if (browser) await browser.close();
    }
  }
};
