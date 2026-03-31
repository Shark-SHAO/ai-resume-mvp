// api/portfolio.js — 作品集分析引擎
// 支持：图片（base64 vision）、URL（抓取内容）、纯文字描述
// 环境变量: DEEPSEEK_API_KEY

const https = require('https');
const http  = require('http');
const { URL } = require('url');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/* ─── 抓取 URL 内容（标题 + meta + 正文前500字）────────────────────────────── */
function fetchUrl(rawUrl) {
  return new Promise((resolve) => {
    try {
      const u  = new URL(rawUrl);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get({
        hostname: u.hostname, path: u.pathname + u.search,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIResume/1.0)' },
        timeout: 6000,
      }, (res) => {
        // 跟随一次重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchUrl(res.headers.location));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { if (body.length < 20000) body += c; });
        res.on('end', () => {
          // 提取 title
          const title = (body.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1]?.trim()||'';
          // 提取 meta description
          const desc  = (body.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)||
                         body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description/i)||[])[1]?.trim()||'';
          // 提取 og:title / og:description
          const ogTitle = (body.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)||[])[1]?.trim()||'';
          const ogDesc  = (body.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i)||[])[1]?.trim()||'';
          // 去掉 HTML 标签取正文
          const text = body.replace(/<script[\s\S]*?<\/script>/gi,'')
                           .replace(/<style[\s\S]*?<\/style>/gi,'')
                           .replace(/<[^>]+>/g,' ')
                           .replace(/\s+/g,' ')
                           .trim()
                           .slice(0, 500);
          resolve({ title: ogTitle||title, desc: ogDesc||desc, text, url: rawUrl, ok: true });
        });
      });
      req.on('error', () => resolve({ ok:false, url:rawUrl }));
      req.on('timeout', () => { req.destroy(); resolve({ ok:false, url:rawUrl }); });
    } catch(e) {
      resolve({ ok:false, url:rawUrl });
    }
  });
}

/* ─── DeepSeek（文字 + 图片 vision）──────────────────────────────────────── */
async function analyzeWithDeepSeek(apiKey, item) {
  const { type, title, tools, desc, url, imageBase64, imageType } = item;

  // 组装 user message content
  let userContent = [];

  // 如果有图片
  if (imageBase64 && type === 'image') {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${imageType||'image/jpeg'};base64,${imageBase64}` }
    });
  }

  // 文字部分
  let textPart = `请分析这个 AI 作品并返回 JSON。\n\n作品标题：${title||'未命名'}\n使用工具：${tools||'未填写'}\n用户描述：${desc||'无'}`;
  if (url) textPart += `\n链接：${url}`;
  if (item._urlContent?.ok) {
    textPart += `\n\n页面抓取内容：\n标题：${item._urlContent.title}\n描述：${item._urlContent.desc}\n正文摘要：${item._urlContent.text}`;
  }
  textPart += `\n\n请返回如下 JSON（直接从 { 开始）：
{
  "summary": "这个作品是做什么的，2-3句，具体",
  "aiScore": 0到100的整数（AI技术含量/创新度）,
  "highlights": ["亮点1","亮点2","亮点3"],
  "aiTools": ["识别到的AI工具1","工具2"],
  "category": "作品类别（如：Web应用/数据分析/自动化工具/创意内容/其他）",
  "complexity": "简单/中等/复杂",
  "tags": ["标签1","标签2","标签3"],
  "suggestion": "针对这个作品可以如何进一步提升，一句话"
}`;
  userContent.push({ type:'text', text: textPart });

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 800,
      temperature: 0.2,
      messages: [
        { role:'system', content:'你是 AI Resume 的作品分析引擎。只输出 JSON，直接从 { 开始，不要 markdown 代码块。' },
        { role:'user',   content: userContent },
      ],
    });
    const req = https.request({
      hostname:'api.deepseek.com', path:'/v1/chat/completions', method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':`Bearer ${apiKey}`,
        'Content-Length':Buffer.byteLength(body),
      },
    }, (res) => {
      let raw='';
      res.on('data', c => raw+=c);
      res.on('end', () => {
        if (res.statusCode!==200) return reject(new Error(`DeepSeek ${res.statusCode}: ${raw.slice(0,200)}`));
        try {
          const data  = JSON.parse(raw);
          const text  = data.choices?.[0]?.message?.content?.trim()||'';
          const clean = text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'').trim();
          resolve(JSON.parse(clean));
        } catch(e) { reject(new Error('解析失败: '+e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, ()=>{ req.destroy(); reject(new Error('超时')); });
    req.write(body); req.end();
  });
}

/* ─── Handler ────────────────────────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method==='OPTIONS') return res.status(200).end();
  if (req.method!=='POST')    return res.status(405).json({error:'Method not allowed'});

  const body = await new Promise((resolve,reject) => {
    let raw='';
    req.on('data', c=>raw+=c);
    req.on('end', ()=>{ try{resolve(JSON.parse(raw));}catch(e){reject(e);} });
    req.on('error', reject);
  });

  const { item } = body; // single portfolio item
  if (!item) return res.status(400).json({error:'缺少 item'});

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return res.status(500).json({error:'DEEPSEEK_API_KEY 未配置'});

  // 如果有 URL，先抓取内容
  if (item.url && item.type==='url') {
    item._urlContent = await fetchUrl(item.url);
  }

  try {
    const analysis = await analyzeWithDeepSeek(apiKey, item);
    return res.status(200).json({ ok:true, analysis });
  } catch(e) {
    // 降级：规则评分
    return res.status(200).json({
      ok: true,
      analysis: {
        summary: item.desc||'AI 构建的作品',
        aiScore: item.tools ? 65 : 40,
        highlights: ['使用 AI 工具辅助构建', '完整可运行的产品'],
        aiTools: item.tools ? item.tools.split(/[,，、\s]+/).filter(Boolean) : [],
        category: '其他',
        complexity: '中等',
        tags: ['AI构建','Vibe Coding'],
        suggestion: '添加作品链接或截图，可以帮助更准确地评估项目价值。',
      },
      _fallback: true,
    });
  }
};
