import puppeteer from '@cloudflare/puppeteer';

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    const url = searchParams.get('url');

    // 基本檢查
    if (!url) {
      return new Response(JSON.stringify({ error: "請在 URL 中提供 ?url=... 參數" }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    }

    // 啟動 Cloudflare Browser Rendering
    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    try {
      // 前置動作：導向目標網頁並等待網路閒置
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      let responseData;

      switch (pathname) {
        // 1. Screenshots (截圖並存入 R2)
        case '/screenshot': {
          const screenshot = await page.screenshot({ fullPage: true });
          const fileName = `screenshot-${Date.now()}.png`;
          await env.BUCKET.put(fileName, screenshot, {
            httpMetadata: { contentType: 'image/png' }
          });
          responseData = { success: true, action: "screenshot", r2_key: fileName };
          break;
        }

        // 2. PDFs (生成 PDF 並存入 R2)
        case '/pdf': {
          const pdf = await page.pdf({ format: 'A4', printBackground: true });
          const fileName = `document-${Date.now()}.pdf`;
          await env.BUCKET.put(fileName, pdf, {
            httpMetadata: { contentType: 'application/pdf' }
          });
          responseData = { success: true, action: "pdf", r2_key: fileName };
          break;
        }

        // 3. Snapshots / HTML / Links / Elements / Structured Data (全功能爬蟲)
        case '/parse': {
          // 抓取網頁原始資料
          const rawData = await page.evaluate(() => {
            return {
              title: document.title,
              html: document.documentElement.outerHTML, // Snapshots / HTML
              links: Array.from(document.querySelectorAll('a')).map(a => ({
                text: a.innerText.trim(),
                href: a.href
              })).filter(l => l.href.startsWith('http')), // Links
              h1: Array.from(document.querySelectorAll('h1')).map(h => h.innerText), // HTML elements
              textContent: document.body.innerText.replace(/\s+/g, ' ').slice(0, 2500) // 用於 AI 處理
            };
          });

          // 透過 Workers AI 將內容轉化為 Markdown 與 結構化數據 (Structured Data)
          const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
            prompt: `請將以下網頁內容整理成一份漂亮的 Markdown 報告，並提取關鍵資訊作為結構化 JSON 物件。內容如下：${rawData.textContent}`
          });

          // 生成向量 (Embedding) - 使用 1024 維度模型匹配你的 js-playground index
          const { data: embeddings } = await env.AI.run('@cf/baai/bge-large-en-v1.5', {
            text: [rawData.textContent]
          });

          // 將結果存入 Vectorize 向量資料庫
          const vectorId = crypto.randomUUID();
          await env.VECTOR_INDEX.upsert([{
            id: vectorId,
            values: embeddings[0],
            metadata: {
              url: url,
              title: rawData.title,
              type: "web_crawl"
            }
          }]);

          responseData = {
            success: true,
            title: rawData.title,
            links: rawData.links.slice(0, 10), // 回傳前 10 個連結
            markdown: aiResponse,
            vectorId: vectorId,
            message: "內容已成功轉換 Markdown 並存入 Vectorize (js-playground)"
          };
          break;
        }

        default:
          return new Response("請選擇 API 路徑: /screenshot, /pdf, 或 /parse", { status: 404 });
      }

      return new Response(JSON.stringify(responseData, null, 2), {
        headers: { 'content-type': 'application/json' }
      });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      });
    } finally {
      // 極其重要：無論成功失敗都要關閉瀏覽器，否則會佔用額度
      await browser.close();
    }
  }
};
