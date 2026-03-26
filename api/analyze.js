// api/analyze.js — AI Resume 分析引擎
// 使用 DeepSeek API (OpenAI 兼容协议)
// 环境变量: DEEPSEEK_API_KEY

const https = require('https');

/* ─── CORS ─────────────────────────────────────────────────────────────────── */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/* ─── ACI 评分计算 ──────────────────────────────────────────────────────────── */
const DIM_MAX = { d1: 500, d2: 600, d3: 500, d4: 400, d5: 380, d6: 150 };
const WEIGHTS  = { d1: .20, d2: .25, d3: .20, d4: .15, d5: .15, d6: .05 };

// 问卷答案下标对应维度 (每题选项分值 1-4)
const QUIZ_DIM = { d1: [4], d2: [0,1,5], d3: [1,5], d4: [2,6], d5: [3], d6: [7] };

function quizDimScore(answers, dim) {
  const idxs = QUIZ_DIM[dim];
  const avg  = idxs.reduce((s, i) => s + (answers[i] ?? 1), 0) / idxs.length;
  return Math.round(((avg - 1) / 3) * DIM_MAX[dim]);
}

function githubDimScores(stats, repos) {
  const s = stats || {};
  const r = repos || [];
  const aiRepoCount = r.filter(repo => repo.ai_signal > 0).length;
  const aiRatio     = r.length > 0 ? aiRepoCount / r.length : 0;
  const deployed    = r.filter(repo => repo.homepage).length;

  const d2 = Math.min(600, Math.round(
    Math.min((s.activeDays || 0) / 25, 1) * 280 +
    Math.min((s.langCount  || 0) /  8, 1) * 160 +
    Math.min((s.commitCount|| 0) / 80, 1) * 160
  ));
  const d3 = Math.min(500, Math.round(aiRatio * 300 + Math.min(aiRepoCount / 5, 1) * 120 + (aiRepoCount > 0 ? 80 : 0)));
  const d5 = Math.min(380, Math.round(Math.min(deployed / 3, 1) * 180 + Math.min((s.totalStars || 0) / 50, 1) * 120 + Math.min((s.forks || 0) / 20, 1) * 80));
  const d6 = Math.min(150, Math.round(Math.min((s.followers || 0) / 100, 1) * 75 + Math.min((s.totalStars || 0) / 30, 1) * 45 + Math.min(r.length / 20, 1) * 30));

  return { d2, d3, d5, d6 };
}

function blendDims(quizAnswers, ghScores) {
  const q = dim => quizDimScore(quizAnswers, dim);
  const g = dim => ghScores[dim] || 0;
  const blend = (qv, gv, qw) => Math.max(30, Math.round(qv * qw + gv * (1 - qw)));
  return {
    d1: q('d1'),
    d2: blend(q('d2'), g('d2'), 0.35),
    d3: blend(q('d3'), g('d3'), 0.30),
    d4: q('d4'),
    d5: blend(q('d5'), g('d5'), 0.40),
    d6: blend(q('d6'), g('d6'), 0.40),
  };
}

function calcAci(dims) {
  return Math.round(Object.keys(dims).reduce((s, k) => s + dims[k] * WEIGHTS[k], 0));
}

/* ─── AI 关键词（用于规则兜底项目识别）────────────────────────────────────── */
const AI_KW = [
  'ai','llm','gpt','claude','openai','langchain','vector','embedding','ml',
  'machine-learning','neural','transformer','agent','bot','assistant','rag',
  'diffusion','huggingface','pytorch','tensorflow','cursor','copilot','deepseek',
  'stable-diffusion','whisper','yolo','opencv','nlp','chatbot','generative',
];

function ruleScore(repo) {
  const text = [repo.name, repo.description || '', ...(repo.topics || [])].join(' ').toLowerCase();
  const matched = AI_KW.filter(kw => text.includes(kw));
  let score = matched.length * 12 + (repo.language === 'Jupyter Notebook' ? 20 : 0) +
    (repo.language === 'Python' ? 6 : 0) + Math.min((repo.stargazers_count || 0) * 2, 20) +
    (repo.homepage ? 10 : 0);
  return { matched: matched.slice(0, 4), score: Math.min(score, 100) };
}

/* ─── DeepSeek API ──────────────────────────────────────────────────────────── */
async function callDeepSeek(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 2000,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: '你是 AI Resume 的分析引擎。严格只输出 JSON，不输出任何 markdown 代码块（不要```）、不输出任何解释文字。直接从 { 开始。',
        },
        { role: 'user', content: prompt },
      ],
    });

    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`DeepSeek HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
        }
        try {
          const data = JSON.parse(raw);
          const text = data.choices?.[0]?.message?.content?.trim();
          if (!text) return reject(new Error('DeepSeek 返回内容为空'));
          // 清理可能残留的 markdown fence
          const clean = text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'').trim();
          resolve(JSON.parse(clean));
        } catch(e) {
          reject(new Error(`DeepSeek 响应解析失败: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('DeepSeek 请求超时 25s')); });
    req.write(body);
    req.end();
  });
}

/* ─── 主 Handler ────────────────────────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // 读取请求体
  const body = await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });

  const { githubData, quizAnswers } = body;

  if (!githubData || !quizAnswers) {
    return res.status(400).json({ error: '缺少 githubData 或 quizAnswers' });
  }

  // 计算维度评分
  const ghRaw = githubDimScores(githubData.stats, githubData.repos);
  const dims  = blendDims(quizAnswers, ghRaw);
  const aci   = calcAci(dims);

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'DEEPSEEK_API_KEY 未配置，请在 Vercel 环境变量中添加' });
  }

  // 准备给 DeepSeek 的数据
  const repos   = githubData.repos || [];
  const user    = githubData.user  || {};
  const stats   = githubData.stats || {};

  const repoList = repos.slice(0, 25).map(r => {
    const rs = ruleScore(r);
    return `- ${r.name} [${r.language||'?'}] ⭐${r.stargazers_count||0} fork:${r.forks_count||0} AI关键词:${rs.matched.join(',')||'无'} "${r.description||''}" ${r.homepage?'[已部署]':''}`;
  }).join('\n');

  const weakDim = Object.entries(dims).sort((a,b) => a[1]/DIM_MAX[a[0]] - b[1]/DIM_MAX[b[0]])[0][0];
  const dimNames = { d1:'模型选择策略', d2:'编程工具使用深度', d3:'AI辅助代码贡献', d4:'Prompt工程能力', d5:'应用构建与部署', d6:'社区影响力' };

  const prompt = `你是 AI Resume 的能力分析引擎，专门评估开发者的 AI 使用能力。

## 开发者 GitHub 数据
- 用户名: ${user.login || '未知'}，姓名: ${user.name || '未知'}
- 公开仓库: ${repos.length} 个，粉丝: ${stats.followers||0}，总 Stars: ${stats.totalStars||0}
- 近30天活跃天数: ${stats.activeDays||0}，AI 相关仓库: ${repos.filter(r=>ruleScore(r).matched.length>0).length} 个
- 主要语言: ${stats.topLanguages?.join(', ')||'未知'}

## 仓库列表（共 ${repos.length} 个，展示前25个）
${repoList || '无仓库数据'}

## ACI 评分
总分: ${aci}/2530，D1模型调用:${dims.d1}/500，D2编程工具:${dims.d2}/600，D3 AI代码:${dims.d3}/500，D4 Prompt:${dims.d4}/400，D5应用构建:${dims.d5}/380，D6影响力:${dims.d6}/150
最弱维度: ${dimNames[weakDim]}

## 你的任务
1. 从仓库列表中选出 3-5 个最能体现 AI 能力的项目（优先选 AI关键词 不为空的，其次选 Stars 高的）
2. 分析能力特征（3-4句，要提及具体仓库名，有洞察，不泛泛而谈）
3. 给出一条针对最弱维度的具体可操作提升建议

严格返回以下 JSON 格式，直接从 { 开始，不要任何前缀：
{
  "projects": [
    {
      "name": "仓库名（原始名称，不要修改）",
      "description": "这个项目是做什么的，一句话",
      "language": "主要编程语言",
      "stars": 数字,
      "aiScore": 0到100的整数（该项目与AI的相关程度）,
      "highlight": "这个项目最能体现AI能力的地方，具体，一句话",
      "aiKeywords": ["检测到的AI关键词，最多3个"]
    }
  ],
  "analysis": "3-4句能力分析，结合真实仓库数据，不要泛泛而谈",
  "tip": "针对${dimNames[weakDim]}的具体提升建议，可操作，一句话"
}`;

  try {
    const result = await callDeepSeek(apiKey, prompt);

    // 校验结构完整性
    if (!result.projects || !result.analysis || !result.tip) {
      throw new Error('DeepSeek 返回结构不完整: ' + JSON.stringify(result).slice(0, 200));
    }

    return res.status(200).json({ dims, aci, projects: result.projects, analysis: result.analysis, tip: result.tip });

  } catch (err) {
    console.error('[analyze] DeepSeek 调用失败:', err.message);
    return res.status(500).json({
      error: `AI 分析失败: ${err.message}`,
      dims,
      aci,
    });
  }
};
