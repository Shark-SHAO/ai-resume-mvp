// api/analyze.js — AI Resume 分析引擎
// 使用 DeepSeek API (OpenAI 兼容协议)
// 环境变量: DEEPSEEK_API_KEY

const https = require('https');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/* ─── ACI 评分 ───────────────────────────────────────────────────────────── */
const DIM_MAX = { d1:500, d2:600, d3:500, d4:400, d5:380, d6:150 };
const WEIGHTS  = { d1:.20, d2:.25, d3:.20, d4:.15, d5:.15, d6:.05 };
const QUIZ_DIM = { d1:[4], d2:[0,1,5], d3:[1,5], d4:[2,6], d5:[3], d6:[7] };

function quizDimScore(answers, dim) {
  const idxs = QUIZ_DIM[dim];
  const avg  = idxs.reduce((s,i) => s+(answers[i]??1), 0) / idxs.length;
  return Math.round(((avg-1)/3) * DIM_MAX[dim]);
}

function githubDimScores(stats, repos) {
  const s = stats||{};
  const r = repos||[];
  const aiCount  = r.filter(x => x.ai_signal > 0).length;
  const aiRatio  = r.length > 0 ? aiCount/r.length : 0;
  const deployed = r.filter(x => x.homepage).length;
  // D2 以活跃天数为主（commitCount 接口不稳定）
  const d2 = Math.min(600, Math.round(
    Math.min((s.activeDays||0)/20, 1)*340 +
    Math.min((s.langCount||0)/6,   1)*160 +
    Math.min(r.length/15,          1)*100
  ));
  const d3 = Math.min(500, Math.round(aiRatio*280 + Math.min(aiCount/4,1)*140 + (aiCount>0?80:0)));
  const d5 = Math.min(380, Math.round(Math.min(deployed/3,1)*200 + Math.min((s.totalStars||0)/30,1)*120 + Math.min(r.length/10,1)*60));
  const d6 = Math.min(150, Math.round(Math.min((s.followers||0)/80,1)*80 + Math.min((s.totalStars||0)/20,1)*50 + Math.min(r.length/15,1)*20));
  return { d2, d3, d5, d6 };
}

// Vibe 作品加分：提升 D3 和 D5
function vibeBoost(vibeProjects) {
  if (!vibeProjects||vibeProjects.length===0) return {d3:0, d5:0};
  const count  = Math.min(vibeProjects.length, 5);
  const hasUrl = vibeProjects.filter(p => p.url&&p.url.startsWith('http')).length;
  return {
    d3: Math.min(count*25, 180),
    d5: Math.min(count*35 + hasUrl*20, 250),
  };
}

function blendDims(quizAnswers, ghScores, vBoost) {
  const q  = dim => quizDimScore(quizAnswers, dim);
  const g  = dim => ghScores[dim]||0;
  const vb = vBoost||{d3:0, d5:0};
  // GitHub 数据少时，问卷权重自动上升
  const hasGhData = (ghScores.d2||0) > 50;
  const d2w = hasGhData ? 0.35 : 0.85;
  const d3w = hasGhData ? 0.30 : 0.80;
  const blend = (qv,gv,qw) => Math.max(30, Math.round(qv*qw + gv*(1-qw)));
  return {
    d1: q('d1'),
    d2: blend(q('d2'), g('d2'), d2w),
    d3: Math.min(DIM_MAX.d3, blend(q('d3'), g('d3'), d3w) + vb.d3),
    d4: q('d4'),
    d5: Math.min(DIM_MAX.d5, blend(q('d5'), g('d5'), 0.40) + vb.d5),
    d6: blend(q('d6'), g('d6'), 0.40),
  };
}

function calcAci(dims) {
  return Math.round(Object.keys(dims).reduce((s,k) => s+dims[k]*WEIGHTS[k], 0));
}

/* ─── AI 关键词 ──────────────────────────────────────────────────────────── */
const AI_KW = [
  'ai','llm','gpt','claude','openai','langchain','vector','embedding','ml',
  'neural','transformer','agent','bot','assistant','rag','diffusion',
  'huggingface','pytorch','tensorflow','cursor','copilot','deepseek',
  'whisper','yolo','opencv','nlp','chatbot','generative','vibe',
];
function ruleScore(repo) {
  const text = [repo.name, repo.description||'', ...(repo.topics||[])].join(' ').toLowerCase();
  const matched = AI_KW.filter(kw => text.includes(kw));
  let score = matched.length*12 + (repo.language==='Jupyter Notebook'?20:0) +
    (repo.language==='Python'?6:0) + Math.min((repo.stargazers_count||0)*2,20) +
    (repo.homepage?10:0);
  return { matched:matched.slice(0,4), score:Math.min(score,100) };
}

/* ─── DeepSeek ───────────────────────────────────────────────────────────── */
async function callDeepSeek(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 2500,
      temperature: 0.3,
      messages: [
        { role:'system', content:'你是 AI Resume 的分析引擎。严格只输出 JSON，直接从 { 开始，不输出 markdown 代码块或任何解释。' },
        { role:'user', content: prompt },
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
        if (res.statusCode!==200) return reject(new Error(`DeepSeek HTTP ${res.statusCode}: ${raw.slice(0,300)}`));
        try {
          const data = JSON.parse(raw);
          const text = data.choices?.[0]?.message?.content?.trim();
          if (!text) return reject(new Error('DeepSeek 返回内容为空'));
          const clean = text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'').trim();
          resolve(JSON.parse(clean));
        } catch(e) { reject(new Error('DeepSeek 响应解析失败: '+e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(28000, () => { req.destroy(); reject(new Error('DeepSeek 请求超时')); });
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
    req.on('data', c => raw+=c);
    req.on('end', () => { try{resolve(JSON.parse(raw));}catch(e){reject(e);} });
    req.on('error', reject);
  });

  const { githubData, quizAnswers, vibeProjects } = body;
  if (!githubData||!quizAnswers) return res.status(400).json({error:'缺少 githubData 或 quizAnswers'});

  const ghRaw  = githubDimScores(githubData.stats, githubData.repos);
  const vBoost = vibeBoost(vibeProjects);
  const dims   = blendDims(quizAnswers, ghRaw, vBoost);
  const aci    = calcAci(dims);

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return res.status(500).json({error:'DEEPSEEK_API_KEY 未配置'});

  const repos  = githubData.repos||[];
  const user   = githubData.user||{};
  const stats  = githubData.stats||{};
  const vProjs = vibeProjects||[];

  const repoList = repos.slice(0,20).map(r => {
    const rs = ruleScore(r);
    return `- ${r.name} [${r.language||'?'}] ⭐${r.stargazers_count||0} AI关键词:[${rs.matched.join(',')||'无'}] "${r.description||''}" ${r.homepage?'[已部署]':''}`;
  }).join('\n');

  const vibeList = vProjs.length > 0
    ? vProjs.map((p,i) => `${i+1}. 【${p.title}】工具:${p.tools} 耗时:${p.time} URL:${p.url||'无'} 描述:${p.desc}`).join('\n')
    : '无';

  const weakDim  = Object.entries(dims).sort((a,b)=>a[1]/DIM_MAX[a[0]]-b[1]/DIM_MAX[b[0]])[0][0];
  const dimNames = {d1:'模型选择策略',d2:'编程工具使用深度',d3:'AI辅助代码贡献',d4:'Prompt工程能力',d5:'应用构建与部署',d6:'社区影响力'};
  const isVibe   = repos.length<=2 && vProjs.length>0;

  const prompt = `你是 AI Resume 的能力分析引擎。

## 用户类型
${isVibe ? 'Vibe Coder — 主要用 AI 工具（Cursor/Claude/GPT）构建产品，GitHub 项目较少，以作品集为主要能力证明' : '开发者 — 有 GitHub 项目记录'}

## GitHub 数据
用户名:${user.login} 仓库:${repos.length}个 活跃天数:${stats.activeDays||0} AI仓库:${stats.aiRepoCount||0}个 Stars:${stats.totalStars||0} 粉丝:${stats.followers||0} 语言:${stats.topLanguages?.join(',')||'未知'}

## GitHub 仓库
${repoList||'无'}

## Vibe 作品集（用户手动提交的 AI 构建项目）
${vibeList}

## ACI 评分
总分:${aci} D1:${dims.d1}/500 D2:${dims.d2}/600 D3:${dims.d3}/500 D4:${dims.d4}/400 D5:${dims.d5}/380 D6:${dims.d6}/150
最弱维度:${dimNames[weakDim]}

## 任务
1. 综合 GitHub + Vibe 作品集，选 3-5 个最能体现 AI 能力的项目（Vibe 作品优先展示）
2. 写 3-4 句能力分析，提及具体项目名，${isVibe?'重点分析 Vibe 构建效率和 AI 工具运用':'结合 GitHub 数据'}，专业有洞察
3. 针对「${dimNames[weakDim]}」给一条具体可操作的提升建议

返回 JSON（直接从 { 开始）：
{
  "projects": [
    {
      "name": "项目名",
      "description": "一句话说这个项目做什么",
      "language": "主要语言或AI工具",
      "stars": 数字,
      "aiScore": 0-100整数,
      "highlight": "最能体现AI能力的亮点，一句话",
      "aiKeywords": ["关键词1","关键词2"],
      "isVibe": true或false
    }
  ],
  "analysis": "3-4句能力分析",
  "tip": "针对${dimNames[weakDim]}的具体提升建议"
}`;

  try {
    const result = await callDeepSeek(apiKey, prompt);
    if (!result.projects||!result.analysis||!result.tip) throw new Error('返回结构不完整');
    return res.status(200).json({ dims, aci, projects:result.projects, analysis:result.analysis, tip:result.tip });
  } catch(err) {
    console.error('[analyze]', err.message);
    // 降级：规则兜底项目 + 真实评分，不展示假分析文字
    const fallbackProjects = [
      ...repos.slice(0,3).map(r => {
        const rs = ruleScore(r);
        return { name:r.name, description:r.description||'暂无描述', language:r.language||'', stars:r.stargazers_count||0, aiScore:rs.score, highlight:rs.matched.length>0?`包含 AI 技术：${rs.matched.join(', ')}`:'代码仓库', aiKeywords:rs.matched, isVibe:false };
      }),
      ...vProjs.slice(0,2).map(p => ({
        name:p.title, description:p.desc, language:p.tools, stars:0, aiScore:72,
        highlight:`使用 ${p.tools} 构建，${p.time} 完成`, aiKeywords:p.tools.split(/[,，、\s]+/).slice(0,3), isVibe:true,
      })),
    ];
    return res.status(200).json({
      dims, aci,
      projects: fallbackProjects,
      analysis: `AI 分析服务暂时不可用。你的 ACI 评分 ${aci} 基于 GitHub 数据和问卷综合计算，评分结果真实有效。`,
      tip: '请稍后重新测试以获取 DeepSeek 个性化分析报告。',
      _fallback: true,
    });
  }
};
