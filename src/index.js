import puppeteer from '@cloudflare/puppeteer';

export default {
  async fetch(request, env) {
    const { searchParams } = new URL(request.url);
    const url = searchParams.get('url');
    const format = searchParams.get('format') || 'json';

    if (!url) return new Response("Missing URL. Usage: ?url=https://example.com&format=[json|pdf|image]", { status: 400 });

    let browser;
    try {
      browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();
      
      // 設定高解析度視窗
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      // 1. 抓取結構化數據、HTML、連結與文字
      const pageContent = await page.evaluate(() => {
        return {
          title: document.title,
          html: document.documentElement.outerHTML.slice(0, 10000), // HTML Elements
          text: document.body.innerText.slice(0, 3000), // 用於 AI 摘要
          links: Array.from(document.querySelectorAll('a')).map(a => a.href).slice(0, 20),
          structuredData: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s => s.innerText)
        };
      });

      // 2. 生成 Markdown 摘要 (Workers AI)
      const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
        prompt: `Summarize the following web content into a clean Markdown format:\n${pageContent.text}`
      });

      // 3. 向量化並存入你已創好的 js-playground (Vectorize)
      const { data: embeddings } = await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [pageContent.text] });
      await env.VECTOR_INDEX.upsert([{
        id: crypto.randomUUID(),
        values: embeddings[0],
        metadata: { url, title: pageContent.title }
      }]);

      // 4. 根據參數返回格式
      if (format === 'pdf') {
        const pdf = await page.pdf({ format: 'A4', printBackground: true });
        return new Response(pdf, { headers: { "content-type": "application/pdf" } });
      }

      const screenshot = await page.screenshot({ fullPage: true });
      if (format === 'image') {
        return new Response(screenshot, { headers: { "content-type": "image/png" } });
      }

      // 預設返回 JSON (包含 Markdown, Links, HTML, Snapshots 資訊)
      const fileName = `snap-${Date.now()}.png`;
      await env.BUCKET.put(fileName, screenshot); // 存入 R2

      return Response.json({
        success: true,
        metadata: {
          title: pageContent.title,
          links: pageContent.links,
          structured_data: pageContent.structuredData
        },
        markdown: aiResponse.response,
        html_sample: pageContent.html.slice(0, 500) + "...",
        r2_snapshot_key: fileName,
        vector_status: "Indexed in js-playground"
      });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    } finally {
      if (browser) await browser.close();
    }
  }
};
