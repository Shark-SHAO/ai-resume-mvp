// api/analytics.js — 作品集数据看板
// GET  /api/analytics?user=login        → 读取统计数据 + AI 建议
// POST /api/analytics                   → 写入一条浏览记录
// 环境变量: DEEPSEEK_API_KEY, KV_REST_API_URL, KV_REST_API_TOKEN

const https = require('https');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/* ─── Vercel KV (REST API) ───────────────────────────────────────────────── */
async function kvGet(key) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url||!token) return null;
  return new Promise((resolve) => {
    const u = new URL(`${url}/get/${encodeURIComponent(key)}`);
    https.get({ hostname:u.hostname, path:u.pathname+u.search,
      headers:{ Authorization:`Bearer ${token}` }
    }, (res) => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{ const r=JSON.parse(d); resolve(r.result?JSON.parse(r.result):null); }catch{ resolve(null); }});
    }).on('error',()=>resolve(null));
  });
}

async function kvSet(key, value, exSeconds) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url||!token) return false;
  const body = JSON.stringify(value);
  return new Promise((resolve) => {
    const path = exSeconds
      ? `/set/${encodeURIComponent(key)}?ex=${exSeconds}`
      : `/set/${encodeURIComponent(key)}`;
    const u = new URL(url);
    const req = https.request({ hostname:u.hostname, path, method:'POST',
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) }
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(true)); });
    req.on('error',()=>resolve(false));
    req.write(body); req.end();
  });
}

/* ─── DeepSeek 分析建议 ──────────────────────────────────────────────────── */
async function getAiAdvice(apiKey, stats, userLogin) {
  const prompt = `你是 AI Resume 的数据分析顾问，分析用户 ${userLogin} 的作品集数据并给出优化建议。

## 数据概览
- 今日浏览量：${stats.todayViews} 次
- 总浏览量：${stats.totalViews} 次
- 独立访客：${stats.uniqueVisitors} 人
- 平均停留时间：${stats.avgTime} 秒
- 最受关注模块：${stats.hotModule||'暂无数据'}
- 最近7天趋势：${JSON.stringify(stats.dailyTrend||[])}
- 各模块停留时间：${JSON.stringify(stats.moduleTime||{})}

请返回 JSON：
{
  "insight": "2-3句核心数据洞察，要有具体数字，不要泛泛而谈",
  "suggestions": [
    {"title":"建议标题","desc":"具体可操作的建议，一句话"},
    {"title":"建议标题","desc":"具体可操作的建议，一句话"},
    {"title":"建议标题","desc":"具体可操作的建议，一句话"}
  ],
  "hotspot": "访客最感兴趣的部分是什么，说明原因"
}`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model:'deepseek-chat', max_tokens:600, temperature:0.3,
      messages:[
        {role:'system', content:'只输出 JSON，直接从 { 开始。'},
        {role:'user', content:prompt},
      ],
    });
    const req = https.request({
      hostname:'api.deepseek.com', path:'/v1/chat/completions', method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}`, 'Content-Length':Buffer.byteLength(body) },
    }, (res) => {
      let raw=''; res.on('data',c=>raw+=c);
      res.on('end',()=>{
        try {
          const data  = JSON.parse(raw);
          const text  = data.choices?.[0]?.message?.content?.trim()||'{}';
          const clean = text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'').trim();
          resolve(JSON.parse(clean));
        } catch { resolve({ insight:'数据分析中...', suggestions:[], hotspot:'' }); }
      });
    });
    req.on('error',()=>resolve({insight:'AI 分析暂时不可用', suggestions:[], hotspot:''}));
    req.setTimeout(15000,()=>{req.destroy();resolve({insight:'分析超时',suggestions:[],hotspot:''});});
    req.write(body); req.end();
  });
}

/* ─── Handler ────────────────────────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method==='OPTIONS') return res.status(200).end();

  const hasKV = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

  /* ── POST: 记录一次浏览 ── */
  if (req.method==='POST') {
    const body = await new Promise((resolve,reject)=>{
      let raw=''; req.on('data',c=>raw+=c);
      req.on('end',()=>{try{resolve(JSON.parse(raw));}catch(e){reject(e);}});
      req.on('error',reject);
    });
    const { user, timeSpent, moduleData, referer } = body;
    if (!user) return res.status(400).json({error:'缺少 user'});

    if (hasKV) {
      const today = new Date().toISOString().slice(0,10);
      const statsKey = `stats:${user}`;
      const stats = await kvGet(statsKey) || {
        totalViews:0, uniqueVisitors:0, dailyTrend:{}, moduleTime:{}, sessions:[]
      };

      stats.totalViews = (stats.totalViews||0) + 1;
      stats.dailyTrend = stats.dailyTrend||{};
      stats.dailyTrend[today] = (stats.dailyTrend[today]||0) + 1;

      // 模块停留时间累加
      if (moduleData && typeof moduleData==='object') {
        stats.moduleTime = stats.moduleTime||{};
        Object.entries(moduleData).forEach(([mod, t]) => {
          stats.moduleTime[mod] = (stats.moduleTime[mod]||0) + (t||0);
        });
      }

      // 保留最近50条 session 记录
      const sessions = stats.sessions||[];
      sessions.push({ time:Date.now(), duration:timeSpent||0, referer:referer||'' });
      stats.sessions = sessions.slice(-50);

      // 计算平均停留时间
      const validSessions = sessions.filter(s=>s.duration>5);
      stats.avgTime = validSessions.length>0
        ? Math.round(validSessions.reduce((s,x)=>s+x.duration,0)/validSessions.length)
        : 0;

      // 最受关注模块
      if (Object.keys(stats.moduleTime).length>0) {
        stats.hotModule = Object.entries(stats.moduleTime).sort((a,b)=>b[1]-a[1])[0][0];
      }

      await kvSet(statsKey, stats, 60*60*24*90); // 保留90天
    }

    return res.status(200).json({ok:true, kvEnabled:hasKV});
  }

  /* ── GET: 读取统计 + AI 建议 ── */
  if (req.method==='GET') {
    const user = req.query?.user || new URL('http://x'+req.url).searchParams.get('user');
    if (!user) return res.status(400).json({error:'缺少 user 参数'});

    if (!hasKV) {
      return res.status(200).json({
        ok: true,
        kvEnabled: false,
        message: '需要配置 Vercel KV 才能开启数据看板',
        stats: null,
        advice: null,
      });
    }

    const stats = await kvGet(`stats:${user}`);
    if (!stats) {
      return res.status(200).json({ ok:true, kvEnabled:true, stats:{
        totalViews:0, uniqueVisitors:0, avgTime:0, hotModule:'暂无',
        dailyTrend:{}, moduleTime:{}, todayViews:0,
      }, advice:null });
    }

    // 今日浏览量
    const today = new Date().toISOString().slice(0,10);
    stats.todayViews = stats.dailyTrend?.[today]||0;

    // 最近7天趋势数组
    const trend7 = [];
    for (let i=6;i>=0;i--) {
      const d = new Date(Date.now()-i*86400000).toISOString().slice(0,10);
      trend7.push({ date:d, views:stats.dailyTrend?.[d]||0 });
    }
    stats.trend7 = trend7;

    // AI 建议
    let advice = null;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (apiKey && stats.totalViews > 0) {
      advice = await getAiAdvice(apiKey, stats, user);
    }

    return res.status(200).json({ ok:true, kvEnabled:true, stats, advice });
  }

  return res.status(405).json({error:'Method not allowed'});
};
